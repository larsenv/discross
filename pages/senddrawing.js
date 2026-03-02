const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');
const { Buffer } = require('buffer');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

async function clean(server, nodelete) {
  (await server.fetchWebhooks()).forEach(async function (item) {
    if ((item.owner.username.search("Discross") !== -1) && (item.id !== nodelete)) {
      try {
        await item.delete();
      } catch (err) { }
    }
  });
}

async function getOrCreateWebhook(channel, guildID) {
  try {
    const existingWebhooks = await channel.fetchWebhooks();
    let webhook = existingWebhooks.find(w => w.owner.username === "discross beta" || w.owner.username === "Discross");

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: "Discross",
        avatar: "pages/static/resources/logo.png",
        reason: "Discross uses webhooks to send messages",
      });
      auth.dbQueryRun("INSERT INTO webhooks VALUES (?,?,?)", [guildID, webhook.id, webhook.token]);
    }
    return webhook;
  } catch (err) {
    console.error("Error fetching/creating webhook:", err);
    throw err;
  }
}

exports.sendDrawing = async function sendDrawing(bot, req, res, args, discordID, urlQuery = null) {
  const t0 = Date.now();
  console.log(`[sendDrawing] start discordID=${discordID}`);
  try {
    let parsedurl;
    if (urlQuery == null) {
      parsedurl = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    } else {
      parsedurl = urlQuery;
    }
    console.log(`[sendDrawing] channelID=${parsedurl.channel} drawinginput_len=${parsedurl.drawinginput ? parsedurl.drawinginput.length : 0}`);

    // Allow sending drawings with or without a message
    console.log(`[sendDrawing] fetching channel (+${Date.now()-t0}ms)`);
    const channel = await bot.client.channels.fetch(parsedurl.channel);
    console.log(`[sendDrawing] channel fetched (+${Date.now()-t0}ms)`);

    let member;
    try {
      console.log(`[sendDrawing] fetching member (+${Date.now()-t0}ms)`);
      member = await channel.guild.members.fetch(discordID);
      console.log(`[sendDrawing] member fetched (+${Date.now()-t0}ms)`);
    } catch (err) {
      console.error(`[sendDrawing] failed to fetch member (+${Date.now()-t0}ms):`, err);
      res.writeHead(500, { "Content-Type": "text/html" });
      res.write("Failed to verify user permissions. Please ensure you have access to this channel or try again later.");
      res.end();
      return;
    }

    if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
      console.warn(`[sendDrawing] user lacks SendMessages permission`);
      res.write("You don't have permission to do that!");
      res.end();
      return;
    }

    console.log(`[sendDrawing] getting webhook (+${Date.now()-t0}ms)`);
    const webhook = await getOrCreateWebhook(channel, channel.guild.id);
    console.log(`[sendDrawing] webhook ready id=${webhook.id} (+${Date.now()-t0}ms)`);

    let processedmessage = parsedurl.message || "";
    
    // Process mentions only if there's a message
    if (processedmessage) {
      const regex = /@([^#]{2,32}#\d{4})/g;
      let m;
      do {
        m = regex.exec(processedmessage);
        if (m) {
          let mentioneduser = channel.guild.members.cache.find(member => member.user.tag === m[1]);
          if (!mentioneduser) {
            try {
              mentioneduser = (await channel.guild.members.fetch()).find(member => member.user.tag === m[1]);
            } catch (err) {
              console.error("Failed to fetch members for mention:", err);
              // Continue without resolving the mention
            }
          }
          if (mentioneduser) {
            processedmessage = strReplace(processedmessage, m[0], `<@${mentioneduser.id}>`);
          }
        }
      } while (m);
    }
    
    const base64Data = parsedurl.drawinginput;

    // Validate that we have drawing data
    if (!base64Data || base64Data.trim() === '') {
      console.error('[sendDrawing] Error processing image: Input Buffer is empty');
      res.writeHead(400, { "Content-Type": "text/html" });
      res.write("No drawing data provided. Please draw something before sending.");
      res.end();
      return;
    }

    // Remove the data URL prefix and detect format for correct filename
    const mimeMatch = base64Data.match(/^data:([^;]+);base64,/);
    const mime = (mimeMatch && mimeMatch[1]) ? mimeMatch[1] : 'image/png';
    const ext = (mime === 'image/jpeg') ? 'jpg' : 'png';
    const base64Image = base64Data.split(';base64,').pop();
    
    // Validate the base64 string is not empty
    if (!base64Image || base64Image.trim() === '') {
      console.error('[sendDrawing] Error processing image: Base64 data is empty after split');
      res.writeHead(400, { "Content-Type": "text/html" });
      res.write("Invalid drawing data format. Please try again.");
      res.end();
      return;
    }

    const imageBuffer = Buffer.from(base64Image, 'base64');
    console.log(`[sendDrawing] imageBuffer size=${imageBuffer.length} bytes (+${Date.now()-t0}ms)`);
    
    // Validate the buffer is not empty
    if (!imageBuffer || imageBuffer.length === 0) {
      console.error('[sendDrawing] Error processing image: Generated buffer is empty');
      res.writeHead(400, { "Content-Type": "text/html" });
      res.write("Failed to process drawing data. Please try again.");
      res.end();
      return;
    }

    // Discord.js requires Buffer for attachments
    const webhookOptions = {
      username: member.displayName || member.user.tag,
      avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
      files: [{
        attachment: imageBuffer,
        name: 'drawing.' + ext
      }]
    };
    
    // Only add content if there's a message
    if (processedmessage && processedmessage.length > 0) {
      webhookOptions.content = processedmessage;
    }
    
    console.log(`[sendDrawing] calling webhook.send (+${Date.now()-t0}ms)`);
    const message = await webhook.send(webhookOptions);
    console.log(`[sendDrawing] webhook.send complete (+${Date.now()-t0}ms)`);
    bot.addToCache(message);
    
    res.writeHead(302, { "Location": `/channels/${parsedurl.channel}#end` });
    res.end();
    console.log(`[sendDrawing] done, redirected (+${Date.now()-t0}ms)`);
  } catch (err) {
    console.error(`[sendDrawing] Error (+${Date.now()-t0}ms):`, err);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.write("An error occurred! Please try again later.<br>"); //write a response to the client
    res.end();
  }
};