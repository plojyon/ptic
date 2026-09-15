const { Client, GatewayIntentBits } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));
const mqtt = require("mqtt");
const { Partials } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const ChartDataLabels = require('chartjs-plugin-datalabels');
const OpenLocationCode = require("open-location-code");

require('dotenv').config();

// load waypoints from disk if available
let w;
try {
	w = require('./waypoints.json')
}
catch {
	w = {};
}

const waypoints = w;
const inregions = {};
const last_seen = {};
const last_transition = {};
const TEMP_WAYPOINT_USER = 'temp';
waypoints[TEMP_WAYPOINT_USER] = [];

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
	console.error('Missing TOKEN in .env file');
	process.exit(1);
}

const API_URL = process.env.OWNTRACKS_URL + (process.env.OWNTRACKS_API_PATH ?? "owntracks/api/0");
const BASIC_AUTH = process.env.OWNTRACKS_BASIC_AUTH;
const FRONTEND_URL = BASIC_AUTH ? process.env.OWNTRACKS_URL.replace("://", `://${BASIC_AUTH}@`) : process.env.OWNTRACKS_URL;

const discord_client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
	],
	partials: [Partials.Channel],
});

// must be global because of reasons
const canvas = new ChartJSNodeCanvas({
	width: 400,
	height: 300,
	backgroundColour: 'white',
	chartCallback: (ChartJS) => {
		ChartJS.register(ChartDataLabels);
	}
});

// stupid fucking formula
function haversineMeters(lat1, lon1, lat2, lon2) {
	const R = 6371000; // meters
	const toRad = x => x * Math.PI / 180;

	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);

	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
		Math.sin(dLon / 2) ** 2;

	return 2 * R * Math.asin(Math.sqrt(a));
}

function discord_send(content, files) {
	discord_client.channels.fetch(process.env.DISCORD_CHANNEL_ID)
		.then(channel => {
			channel.send({content, files})
		})
		.catch(console.error);
}
function ago(d) {
	const s = Math.floor((Date.now() - (new Date(d)).getTime()) / 1000);
	if (s > 86400) return ">24h ago";

	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;

	let result = "";
	if (h > 0) result += `${h}h `;
	if (m > 0) result += `${m}m `;
	if (s > 0) result += `${sec}s `;
	if (result === "") result = "just now";
	else result = result + "ago";
	return result;
}
function linkto(lat, lon) {
	return `<https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}>`;
}
function all_waypoints() {
	return Object.keys(waypoints).reduce((acc, user) => acc.concat(waypoints[user]), [])
}
function get_wp(name) {
	return all_waypoints().find(wp => wp.desc === name);
}
const wp2str = (wp) => `**${wp.desc}** [(${wp.lat}, ${wp.lon}, +-${wp.rad}m)](${linkto(wp.lat, wp.lon)})`;

function notquiteiso(d) {
	// yyyy-mm-ddThh:mm:ss
	const quiteiso = d.toISOString();
	return quiteiso.split('.')[0];
}

function format_human_seconds (input_time_seconds) {
    var temp = Math.floor(input_time_seconds);
    var years = Math.floor(temp / 31536000);
	let out = "";
    if (years) {
        out += ' ' + years + 'y';
    }
    //TODO: Months! Maybe weeks? 
    var days = Math.floor((temp %= 31536000) / 86400);
    if (days) {
        out += ' ' + days + 'd';
    }
    var hours = Math.floor((temp %= 86400) / 3600);
    if (hours) {
        out += ' ' + hours + 'h';
    }
    var minutes = Math.floor((temp %= 3600) / 60);
    if (minutes) {
        out += ' ' + minutes + 'min';
    }
    var seconds = temp % 60;
    if (seconds) {
        out += ' ' + seconds + 's';
    }
	if (out.length == 0) {
		return 'less than a second'; //'just now' //or other string you like;
	} else {
		return out.substring(1);
	}
}


const get_regions = (data) => {
	const new_regions = new Set();
	// check all waypoints of all users
	for (const [u, wps] of Object.entries(waypoints)) {
		for (const wp of wps) {
			const distance = haversineMeters(data.lat, data.lon, wp.lat, wp.lon);
			if (distance < wp.rad) {
				new_regions.add(wp);
			}
		}
	}

	return [...new_regions]
}

async function pie(hist) {
	const total_time = Object.values(hist).reduce((acc, v) => acc+v);
	const configuration = {
		type: 'pie',
		data: {
			labels: Object.keys(hist),
			datasets: [{
				data: Object.values(hist).map(x => x * 100 / total_time),
			}],
		},
		options: {
			responsive: false,
			animation: false,
			plugins: {
				legend: {
					display: false,
					// position: "top",
					// labels: {
					//     pointStyle: "circle",
					//     font: {
					//         size: 14,
					//         weight: "bold"
					//     }
					// }
				},
				datalabels: {
					color: '#333333',
					font: {
						size: 14,
						weight: "bold",
						anchor: "end",
					},
					formatter: (value, context) => {
						return context.chart.data.labels[context.dataIndex];
					}
				}
			}
		},
	};

	return await canvas.renderToBuffer(configuration);
}
const get_time_spent_histogram = (points) => {
	const hist_separate = {}; // desc -> total seconds
	const hist_combined = {}; // desc -> total seconds
    let prev_point;
 
    const addTime = (histogram, desc, seconds) => {
        if (seconds <= 0) return;
        histogram[desc] = (histogram[desc] || 0) + seconds;
    };

    for (let i = 0; i < points.length; i++) {
        const current = points[i];
		const regions_separate = get_regions(current);
        const regions_combined = regions_separate.sort((a,b) => a.rad - b.rad).map(x => x.desc).join(", ") || "unknown";

        if (prev_point !== undefined) {
            const deltaSeconds = current.tst - prev_point.tst;
            if (deltaSeconds < 0) {
                console.error("get_time_spent_histogram encountered an unordered point");
                prev_point = current;
                continue;
            }
 
			for (const wp of regions_separate) {
                addTime(hist_separate, wp.desc, deltaSeconds);
            }
			addTime(hist_combined, regions_combined, deltaSeconds);
        }
        prev_point = current;
    }

	const totalSpan = points.length > 1
    ? points.at(-1).tst - points[0].tst
    : 0;

	console.log("POINT COUNT:", points.length);
	console.log("FIRST TST:", points[0]?.tst);
	console.log("LAST TST:", points.at(-1)?.tst);
	console.log("TOTAL SPAN:", format_human_seconds(totalSpan));
	console.log("HISTOGRAMS:", hist_separate, hist_combined);

    // return hist_separate;
	return hist_combined;
}

const fetch_devices = (user) =>  
	new Promise((res, rej) => fetch(`${API_URL}/list?user=${user}`, {
		"headers": {
			"authorization": `Basic ${btoa(BASIC_AUTH)}`,
		},
	}).then(x => x.json()).then(x => res(x.results)))

const fetch_locations = (url) => {
	console.log(url);

	return new Promise((res, rej) => fetch(url, {
		"headers": {
			"authorization": `Basic ${btoa(BASIC_AUTH)}`,
		},
	}).then(x => x.json()).then(x => res(x)))}


discord_client.on('clientReady', () => {
	console.log(`Logged in as ${discord_client.user.tag}`);
	const serialize_wps = (wps) => wps.reduce((acc, wp) => acc += `\n* ${wp.desc}`, "");
	let wps = Object.keys(waypoints).reduce((acc, user) => acc += `\n# ${user}` + serialize_wps(waypoints[user]), "");
	if (!wps) {
		wps = " No waypoints have been preconfigured.";
	}
	discord_send(`Reincarnated. Loaded ${waypoints.system.length} system waypoints.`);
});

async function parse_location(location_str, follow_redirect=true) {
	const re_coords1 = location_str.match(/(?<lat>-?\d{1,3}\.\d{4,7}), ?(?<lon>-?\d{1,3}\.\d{4,7})/);
	const re_coords2 = location_str.match(/(?<latdeg>\d\d?)°(?<latmin>\d\d?)['′](?<latsec>\d+(?:\.\d+)?)["″](?<northsouth>[NS]) (?<londeg>\d\d?)°(?<lonmin>\d\d?)['′](?<lonsec>\d+(?:\.\d+)?)["″](?<eastwest>[EW])/i);
	const re_plus = location_str.match(/(?<pluscode>[23456789CFGHJMPQRVWX]+\+[23456789CFGHJMPQRVWX]+)/i);

	let lat;
	let lon;
	if (re_coords1 != null) {
		console.log("matched re_coords1", re_coords1);
		lat = parseFloat(re_coords1.groups.lat);
		lon = parseFloat(re_coords1.groups.lon);
		return {lat, lon};
	}
	if (re_coords2 != null) {
		console.log("matched re_coords2", re_coords2);
		const g = re_coords2.groups;
		lat = (parseFloat(g.latdeg) + parseFloat(g.latmin) / 60 + parseFloat(g.latsec) / 3600) * (g.northsouth.toUpperCase() === "N" ? 1 : -1);
		lon = (parseFloat(g.londeg) + parseFloat(g.lonmin) / 60 + parseFloat(g.lonsec) / 3600) * (g.eastwest.toUpperCase() === "E" ? 1 : -1);
		return {lat, lon};
	}
	if (re_plus != null) {
		console.log("matched re_plus", re_plus);
		const pluscode = re_plus.groups.pluscode.toUpperCase();
		const olc = new OpenLocationCode.OpenLocationCode();
		const full = olc.recoverNearest(pluscode, 46.05, 14.51);
		//const area = olc.decode(pluscode);
		const area = olc.decode(full);
		lat = area.latitudeCenter;
		lon = area.longitudeCenter;
		return {lat, lon};
	}
	if (follow_redirect && location_str.startsWith("http")) {
		const response = await fetch(location_str, {redirect: "follow"});
		console.log("following redirect from", location_str, "to", response.url);
		return parse_location(response.url, follow_redirect=false);
	}

	throw new Error(`Could not find coordinates in ${location_str}`);
}

const parse_timespan = (timespan_str) => {
	if (timespan_str == null) {
		// check for null or undefined
		// https://stackoverflow.com/a/21273362
		return undefined;
	}

	const now = Date.now();
	let start = new Date();
	let end = new Date();

	const timespan_re = timespan_str.match(/^(\d+)([mhd']|min)$/) || timespan_str.match(/^(today|yesterday)$/i);
	if (!timespan_re) {
		throw new Error(`Invalid timespan format. Supports: "today", "yesterday", or an integer followed by "m", "h", or "d".`);
	}

	if (timespan_re[2]) {
		const amount = parseInt(timespan_re[1]);
		const unit = timespan_re[2];
		if (unit === 'm' || unit === 'min' || unit === "'") start = new Date(now - amount * 60 * 1000);
		else if (unit === 'h') start = new Date(now - amount * 3600 * 1000);
		else if (unit === 'd') start = new Date(now - amount * 24 * 3600 * 1000);
	} else {
		const day = timespan_re[1].toLowerCase();
		start.setHours(0, 0, 0, 0);
		end.setHours(23, 59, 59, 999);
		if (day === 'yesterday') {
			start.setDate(start.getDate() - 1);
			end.setDate(end.getDate() - 1);
		}
	}
	return [start, end];
}

const where = (user, timespan, callback) => {
	if (last_seen[user] == null) {
		callback(`${user} who?`);
		return;
	}

	if (timespan == null) {
		const loc = last_seen[user].where;
		const locstr = `[(${loc.lat}, ${loc.lon}) +-${loc.acc}m](${linkto(loc.lat, loc.lon)})`;
		const timestr = ago(last_seen[user].when);
		// left FRI 3s ago / arrived at HOME 5m ago / no waypoint activity yet
		let last_transition_str = "no waypoint activity yet";
		if (last_transition[user]) {
			if (last_transition[user].enter) {
				last_transition_str = `arrived at`;
			} else {
				last_transition_str = `left`;
			}
			const wp = get_wp(last_transition[user].name);
			const wp_link = linkto(wp.lat, wp.lon);
			last_transition_str += ` [${last_transition[user].name}](${wp_link})`;

			const when_str = ago(last_transition[user].when);
			last_transition_str += ` ${when_str}`;
		}
		callback(`${user} was at ${locstr} ${timestr} (${last_transition_str}).`);
	}
	else {
		const params = new URLSearchParams();
		params.set('user', user);
		params.set('start', notquiteiso(timespan[0]));
		params.set('end', notquiteiso(timespan[1]));
		const url = `${FRONTEND_URL}?${params.toString()}`;
		callback(`${user} be like: ${url}`);
	}
}

const hist = (user, timespan, callback) => {
	fetch_devices(user).then(devices => {
		const params = new URLSearchParams();
		params.set('user', user)
		params.set('device', devices[0])
		params.set('from', notquiteiso(timespan[0]))
		params.set('to', notquiteiso(timespan[1]))

		const url = `${API_URL}/locations?${params.toString()}`;
		return fetch_locations(url).then(loc => {
			const histogram = get_time_spent_histogram(loc.data.sort((a,b) => a.tst - b.tst));
			const report = Object.entries(histogram).map(
				([waypoint, time]) => `- ${waypoint}: **${format_human_seconds(time)}**`
			).join(`\n`);
			console.log(histogram);

			if (report == null) {
				callback("John Cena moment");
			} else {
				pie(histogram).then(img => {
					files = [{
						attachment: img,
						name: "histogram.png",
					}]
					callback(`${user} been hanging around:\n${report}`, files);
				});
			}
		})
	}).catch(console.error)
}

const notify = async (author, target, location_str, range, name, callback) => {
	let waypoint_obj = {
		"desc": name,
		"temp": true,
		"tag_discord_user_id": author,
		"rad": range,
		"target_filter": [target],
	};

	if (waypoints[TEMP_WAYPOINT_USER].filter(x => x.desc == waypoint_obj.desc)?.length != 0) {
		return callback(`waypoint with desc ${waypoint_obj.desc} already exists`);
	}
	const location = await parse_location(location_str);
	waypoint_obj = {...waypoint_obj, ...location};

	// memory safe :)
	if (waypoints[TEMP_WAYPOINT_USER].filter(x => x.desc == waypoint_obj.desc)?.length != 0) {
		return callback(`waypoint with desc ${waypoint_obj.desc} already exists`);
	}
	waypoints[TEMP_WAYPOINT_USER].push(waypoint_obj);
	const location_url = linkto(location.lat, location.lon);
	return callback(`Ok, I will shit on your head when ${target} enters [the location](${location_url}).`);
}

discord_client.on('messageCreate', async message => {
	if (message.author.bot) return;

	if (message.content.toLowerCase().startsWith('notify ')) {
		const re = message.content.match(/^notify\s+(?<who>\w+)(?:\s(?<range>\d+)m)?(?:\s(?<where>.+))$/i);
		if (re == null) return;
		const target = re?.groups?.who;
		const location_str = re?.groups?.where;
		const range = re?.groups?.range || '100';
		const name = `${location_str} +-${range}`;
		try {
			await notify(message.author.id, target, location_str, range, name, discord_send);
		}
		catch (e) {
			discord_send(e.message);
			return;
		}

	} else if (message.content.toLowerCase().startsWith('where ')) {
		const re = message.content.match(/^where\s+(?<who>\w+)(?:\s(?<when>[\w']+))?$/i);
		if (re == null) return;
		const query = re?.groups?.who;
		const timespan = re?.groups?.when;
		try {
			where(query, parse_timespan(timespan), discord_send);
		}
		catch (e) {
			discord_send(e.message);
			return;
		}

	} else if (message.content.toLowerCase().startsWith('hist ')) {
		const re = message.content.match(/^hist\s+(?<who>\w+)(?:\s(?<when>\w+))?$/i);
		if (re == null) return;
		const user = re?.groups?.who;
		const timespan = re?.groups?.when || "today";
		try {
			hist(user, parse_timespan(timespan), discord_send);
		}
		catch (e) {
			discord_send(e.message);
			return;
		}
	}
});

discord_client.login(TOKEN);


const MQTT_ADDRESS = process.env.MQTT_ADDRESS;
const mqtt_client = mqtt.connect(MQTT_ADDRESS, {
	username: process.env.MQTT_USERNAME,
	password: process.env.MQTT_PASSWORD
}).on('connect', () => {
	console.log('MQTT connected');

	// System waypoint events ("owntracks/+/+/event") are useless to us, because
	// we want to track all waypoints for all users.
	subscriptions = ["owntracks/+/+/waypoints", "owntracks/+/+"];
	for (const sub of subscriptions) {
		mqtt_client.subscribe(sub, (err) => {
			if (err) {
				console.error('Subscribe error:', err);
			} else {
				console.log(`Subscribed to ${sub}`);
			}
		});
	}
});

mqtt_client.on('message', (topic, message) => {
	const payload = message.toString();
	let data;
	let user;
	try {
		data = JSON.parse(payload);
		user = topic.split('/')[1];
	}
	catch (e) {
		console.error('Error parsing waypoints JSON:', e);
		return;
	}

	console.log(`Received message on topic ${topic}`);

	try {
		if (topic.endsWith('/waypoints')) {
			// find which waypoints were added and which were removed
			const new_waypoints = data.waypoints.map(wp => wp.desc);
			const old_waypoints = waypoints[user] ? waypoints[user].map(wp => wp.desc) : [];
			const same_waypoints = new_waypoints.filter(x => old_waypoints.includes(x));

			const added = new_waypoints.filter(x => !old_waypoints.includes(x)).map(x => {
				const wp = data.waypoints.find(wp => wp.desc === x);
				return `\\+ ${wp2str(wp)}`;
			});
			const removed = old_waypoints.filter(x => !new_waypoints.includes(x)).map(x => {
				const wp = waypoints[user].find(wp => wp.desc === x);
				return `\\- ${wp2str(wp)}`;
			});
			const modified = same_waypoints.map(wp_desc => {
				// compare lat,lon,rad
				const new_wp = data.waypoints.find(wp => wp.desc === wp_desc);
				const old_wp = waypoints[user].find(wp => wp.desc === wp_desc);
				if (new_wp.lat !== old_wp.lat || new_wp.lon !== old_wp.lon || new_wp.rad !== old_wp.rad) {
					return `<~ ${wp2str(wp)}\n~> ${wp2str(wp)}`;
				}
			}).filter(x => x !== undefined);

			changes = "";
			if (added.length !== 0)
				changes += `${added.join('\n')}\n`;
			if (removed.length !== 0)
				changes += `${removed.join('\n')}\n`;
			if (modified.length !== 0)
				changes += `${modified.join('\n')}\n`;
			if (changes !== "")
				discord_send(`${user} updated waypoints:\n${changes.trim()}`);
			else
				discord_send(`Stupid ${user} re-uploaded waypoints with NO changes. What a waste of bandwidth!`);

			waypoints[user] = data.waypoints;
			inregions[user] = undefined;
		}
		// Useless system waypoint events
		// else if (topic.endsWith('/event')) {
		//	 if (data._type !== 'transition') return;
		//	 event_desc = data.event === 'enter' ? 'arrived at' : 'left';

		//	 discord_send(`${data.tid} ${event_desc} ${data.desc}`);
		// }
		else {
			if (!data.lon || !data.lat || !data.acc) {
				console.error('User is in void.', user, data);
				return;
			}
			const prev_regions = inregions[user]; // may be undefined!
			last_seen[user] = { when: Date.now(), where: data };

			let new_region_objs = get_regions(data)
			new_region_objs = new_region_objs.filter(wp => wp.target_filter != undefined? wp.target_filter.includes(user) : true)

			const region_name_to_obj = {}
			new_region_objs.forEach(wp => {
				region_name_to_obj[wp.desc] = wp;
			})
			let new_regions = new_region_objs.map(x => x.desc);

			if (prev_regions !== undefined) {
				const arrived = new_regions.filter(x => !prev_regions || !prev_regions.includes(x));
				const departed = (prev_regions || []).filter(x => !new_regions.includes(x));

				// DEBUG location string
				//const distances_to_waypoints = Object.keys(waypoints)
				//	.reduce((acc, user) => acc.concat(waypoints[user]), [])
				//	.map(wp => {
				//		const distance = haversineMeters(data.lat, data.lon, wp.lat, wp.lon);
				//		const d_str = distance > 1000 ? (distance / 1000).toFixed(2) + 'km' : Math.round(distance) + 'm';
				//		return `* ${wp.desc}: ${d_str}`;
				//	})
				//	.join('\n');
				//const loc = `bro is @ [(${data.lat}, ${data.lon})](${linkto(data.lat, data.lon)}) +-${data.acc}m. Distances:\n${distances_to_waypoints}`;
				for (const region of arrived) {
					const region_obj = region_name_to_obj[region];
					discord_send(`${region_obj.tag_discord_user_id? `<@${region_obj.tag_discord_user_id}> `: ''}${user} arrived at ${region}`);
					last_transition[user] = {"name": region, "enter": true, "when": Date.now()};

					if(region_obj.temp) {
						waypoints[TEMP_WAYPOINT_USER] = waypoints[TEMP_WAYPOINT_USER].filter(x => x.desc != region)

						// to prevent User left temp waypoint
						new_regions = new_regions.filter(x => x != region)
					}

				}
				for (const region of departed) {
					discord_send(`${user} left ${region}`);
					last_transition[user] = {"name": region, "enter": false, "when": Date.now()};
				}

			}
			inregions[user] = new_regions;
		}
	}
	catch (e) {
		console.error('Error handling MQTT message:', e);
	}
});

