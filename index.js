const { Client, GatewayIntentBits } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));
const mqtt = require("mqtt");
const { Partials } = require('discord.js');

require('dotenv').config();

const waypoints = {};
const inregions = {};
const last_seen = {};
const last_transition = {};

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
	console.error('Missing TOKEN in .env file');
	process.exit(1);
}

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

discord_client.on('clientReady', () => {
	console.log(`Logged in as ${discord_client.user.tag}`);
	discord_send("Pls upload waypoints");
});

discord_client.on('messageCreate', async message => {
	if (message.author.bot) return;

	const query = message.content.match(/^where\s+(\w+)$/i)?.[1];
	if (!query) return;

	if (!last_seen[query]) {
		discord_send(`${query} who?`);
		return;
	}

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
		const wp = waypoints[query]?.find(wp => wp.desc === last_transition[query].name);
		const wp_link = linkto(wp.lat, wp.lon);
		last_transition_str += ` [${last_transition[query].name}](${wp_link})`;

		const when_str = ago(last_transition[query].when);
		last_transition_str += ` ${when_str}`;
	}
	const wpstr = waypoints[query] ? `${waypoints[query].length} waypoints` : "no waypoints";
	discord_send(`${query} reported ${timestr} at ${locstr} (${last_transition_str}).`);
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
				return `\\+ **${wp.desc}** [(${wp.lat}, ${wp.lon}, +-${wp.rad}m)](${linkto(wp.lat, wp.lon)})`;
			});
			const removed = old_waypoints.filter(x => !new_waypoints.includes(x)).map(x => {
				const wp = waypoints[user].find(wp => wp.desc === x);
				return `\\- **${wp.desc}** [(${wp.lat}, ${wp.lon}, +-${wp.rad}m)](${linkto(wp.lat, wp.lon)})`;
			});
			const modified = same_waypoints.map(wp_desc => {
				// compare lat,lon,rad
				const new_wp = data.waypoints.find(wp => wp.desc === wp_desc);
				const old_wp = waypoints[user].find(wp => wp.desc === wp_desc);
				if (new_wp.lat !== old_wp.lat || new_wp.lon !== old_wp.lon || new_wp.rad !== old_wp.rad) {
					return `\\~ **${wp_desc}** [(${old_wp.lat}, ${old_wp.lon}, +-${old_wp.rad}m)](${linkto(old_wp.lat, old_wp.lon)}) -> [(${new_wp.lat}, ${new_wp.lon}, +-${new_wp.rad}m)](${linkto(new_wp.lat, new_wp.lon)})`;
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
			const prev_regions = inregions[user]; // may be undefined!
			const new_regions = [];
			last_seen[user] = { when: Date.now(), where: data };

			// check all waypoints of all users
			for (const [u, wps] of Object.entries(waypoints)) {
				for (const wp of wps) {
					const distance = haversineMeters(data.lat, data.lon, wp.lat, wp.lon);
					console.log(`Distance from ${user} to waypoint ${wp.desc} of ${u}: ${distance} (radius: ${wp.rad})`);
					if (distance < wp.rad) {
						new_regions.push(wp.desc);
					}
				}
			}

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

