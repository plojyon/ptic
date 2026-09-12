const { Client, GatewayIntentBits } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));
const mqtt = require("mqtt");
const { Partials } = require('discord.js');

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

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
	console.error('Missing TOKEN in .env file');
	process.exit(1);
}

const OWNTRACKS_PASS = process.env.OWNTRACKS_PASS;

const discord_client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
	],
	partials: [Partials.Channel],
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
function discord_send(content) {
	discord_client.channels.fetch(process.env.DISCORD_CHANNEL_ID)
		.then(channel => {
			channel.send(content);
		}
		)
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
			//console.log(distance, wp.desc)
			if (distance < wp.rad) {
				new_regions.add(wp.desc);
			}
		}
	}

	return [...new_regions]
}

const get_time_spent_histogram = (points) => {
	const histogram = {}; // desc -> total seconds
    let prev_regions;
    let prev_point;
 
    const addTime = (desc, seconds) => {
		//console.log("add time", desc, seconds)
        if (seconds <= 0) return;
        histogram[desc] = (histogram[desc] || 0) + seconds;
    };
 
    for (let i = 0; i < points.length; i++) {
        const current = points[i];
        const regions = get_regions(current);
 
        if (prev_point !== undefined) {
            const deltaSeconds = current.tst - prev_point.tst;
            if (deltaSeconds < 0) {
                console.error("get_time_spent_histogram encountered an unordered point");
                prev_point = current;
                prev_regions = regions;
                continue;
            }
 
            const departed = (prev_regions || []).filter((r) => !regions.includes(r));
            const stayed = regions.filter((r) => prev_regions.includes(r));

            // Stayed in this region the whole interval -> full delta
            for (const wp of [...stayed, ...departed]) {
                addTime(wp, deltaSeconds);
            }
        }
 
        prev_point = current;
        prev_regions = regions;
    }

	const totalSpan = points.length > 1
    ? points.at(-1).tst - points[0].tst
    : 0;

	const histogramTotal = Object.values(histogram)
		.reduce((sum, seconds) => sum + seconds, 0);

	console.log("POINT COUNT:", points.length);
	console.log("FIRST TST:", points[0]?.tst);
	console.log("LAST TST:", points.at(-1)?.tst);
	console.log("TOTAL SPAN:", format_human_seconds(totalSpan));
	console.log("HISTOGRAM:", histogram);
	console.log("HISTOGRAM TOTAL:", format_human_seconds(histogramTotal));
 
    return histogram;
}

const fetch_owntracks_devices = (user) =>  
	new Promise((res, rej) => fetch(`${process.env.OWNTRACKS_API_URL}/list?user=${user}`, {
		"headers": {
			"authorization": `Basic ${btoa(OWNTRACKS_PASS)}`,
		},
	}).then(x => x.json()).then(x => res(x.results)))

const fetch_owntracks_locations = (url) => {
	console.log(url);

	return new Promise((res, rej) => fetch(url, {
		"headers": {
			"authorization": `Basic ${btoa(OWNTRACKS_PASS)}`,
		},
	}).then(x => x.json()).then(x => res(x)))}


discord_client.on('clientReady', () => {
	console.log(`Logged in as ${discord_client.user.tag}`);
	const serialize_wps = (wps) => wps.reduce((acc, wp) => acc += `\n* ${wp.desc}`, "");
	let wps = Object.keys(waypoints).reduce((acc, user) => acc += `\n# ${user}` + serialize_wps(waypoints[user]), "");
	if (!wps) {
		wps = " No waypoints have been preconfigured.";
	}
	discord_send("Reincarnated. Waypoints reset." + wps);
});

discord_client.on('messageCreate', async message => {
	if (message.author.bot) return;

	const re = message.content.match(/^where\s+(?<who>\w+)(?:\s(?<when>\w+))(?:\s(?<histwaypoint>\w+))?$/i);
	const query = re?.groups?.who;
	const timespan = re?.groups?.when;
	const histwaypoint = re?.groups?.histwaypoint;
	console.log(`Received query: ${query}, timespan: ${timespan}`);
	console.log('re:', re);

	if (!query) return;

	if (!last_seen[query]) {
		discord_send(`${query} who?`);
		return;
	}

	if (!timespan) {
		const loc = last_seen[query].where;
		const locstr = `[(${loc.lat}, ${loc.lon}) +-${loc.acc}m](${linkto(loc.lat, loc.lon)})`;
		const timestr = ago(last_seen[query].when);
		// left FRI 3s ago / arrived at HOME 5m ago / no waypoint activity yet
		let last_transition_str = "no waypoint activity yet";
		if (last_transition[query]) {
			if (last_transition[query].enter) {
				last_transition_str = `arrived at`;
			} else {
				last_transition_str = `left`;
			}
			const wp = get_wp(last_transition[query].name);
			const wp_link = linkto(wp.lat, wp.lon);
			last_transition_str += ` [${last_transition[query].name}](${wp_link})`;

			const when_str = ago(last_transition[query].when);
			last_transition_str += ` ${when_str}`;
		}
		discord_send(`${query} was at ${locstr} ${timestr} (${last_transition_str}).`);
	}
	else {
		const now = Date.now();
		const timespan_re = timespan.match(/^(\d+)([mhd])$/) || timespan.match(/^(today|yesterday)$/i);
		if (!timespan_re) {
			discord_send(`Invalid timespan format. Supports: "today", "yesterday", or an integer followed by "m", "h", or "d".`);
			return;
		}

		const params = new URLSearchParams();
		params.set('user', query);
		if (timespan_re[2]) {
			const amount = parseInt(timespan_re[1]);
			const unit = timespan_re[2];
			let start;
			if (unit === 'm') start = new Date(now - amount * 60 * 1000);
			else if (unit === 'h') start = new Date(now - amount * 3600 * 1000);
			else if (unit === 'd') start = new Date(now - amount * 24 * 3600 * 1000);
			params.set('start', notquiteiso(start));
			params.set('end', notquiteiso(new Date()));
		} else {
			const day = timespan_re[1].toLowerCase();
			let start = new Date();
			let end = new Date();
			start.setHours(0, 0, 0, 0);
			end.setHours(23, 59, 59, 999);
			if (day === 'yesterday') {
				start.setDate(start.getDate() - 1);
				end.setDate(end.getDate() - 1);
			}
			params.set('start', notquiteiso(start));
			params.set('end', notquiteiso(end));
		}
		
		if(histwaypoint) {
			if (histwaypoint == 'all') {
				fetch_owntracks_devices(query).then(devices => {
					params.set('user', query)
					params.set('device', devices[0])

					// stupid parameter rewrite
					params.set('from', params.get('start'))
					params.set('to', params.get('end'))
					params.delete('start')
					params.delete('end')

					const url = `${process.env.OWNTRACKS_API_URL}/locations?${params.toString()}`;
					return fetch_owntracks_locations(url).then(loc => {
						const report = Object.entries(
							get_time_spent_histogram(loc.data.sort((a,b) => a.tst - b.tst))).map(
								([waypoint, time]) => 
									`${waypoint}: **${format_human_seconds(time)}**`
							).join(`\n -`)
						discord_send(`${query} be like:\n -${report}`)
					})
				}).catch(console.error)
			} else {
				discord_send('<histwaypoint> should be all, others are not supported yet');	
			}
		} else {
			const url = `${process.env.OWNTRACKS_URL}?${params.toString()}`;
			discord_send(`${query} be like: ${url}`);
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

			const new_regions = get_regions(data).map(x => x.desc);

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
					discord_send(`${user} arrived at ${region}`);
					last_transition[user] = {"name": region, "enter": true, "when": Date.now()};
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

