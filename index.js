const { Client, GatewayIntentBits } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));
const mqtt = require("mqtt");
const { Partials } = require('discord.js');

require('dotenv').config();

const waypoints = {};
const inregions = {};

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


discord_client.on('clientReady', () => {
    console.log(`Logged in as ${discord_client.user.tag}`);
    discord_send("Pls upload waypoints");
});

discord_client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const isPrefixed = /\/\w/.test(message.content);

    if (!isPrefixed) return;
    const [topic, ...payloadParts] = message.content.split(' ');

    try {
        mqtt_client.publish(topic.slice(1), payloadParts.join(' '));
    }
    catch (e) {
        message.reply('No.');
        console.error('Error publishing MQTT message:', e);
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
            
            const added = new_waypoints.filter(x => !old_waypoints.includes(x));
            const removed = old_waypoints.filter(x => !new_waypoints.includes(x));

            changes = "";
            if (added.length !== 0)
                changes += `+${added.join('\n+')}`;
            if (removed.length !== 0)
                changes += `-${removed.join('\n-')}`;
            if (changes !== "")
                discord_send(`${user} updated waypoints:\n${changes}`);

            waypoints[user] = data.waypoints;
            inregions[user] = undefined;
        }
        // Useless system waypoint events
        // else if (topic.endsWith('/event')) {
        //     if (data._type !== 'transition') return;
        //     event_desc = data.event === 'enter' ? 'arrived at' : 'left';

        //     discord_send(`${data.tid} ${event_desc} ${data.desc}`);
        // }
        else {
            const prev_regions = inregions[user]; // may be undefined!
            const new_regions = [];

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
				const loc = `bro is @ (${data.lat}, ${data.lon})+-${data.acc}`;
                for (const region of arrived) {
                    discord_send(`${user} arrived at ${region}\n${loc}`);
                }
                for (const region of departed) {
                    discord_send(`${user} left ${region}\n${loc}`);
                }
            }

            inregions[user] = new_regions;
        }
    }
    catch (e) {
        console.error('Error handling MQTT message:', e);
    }
});

