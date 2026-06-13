'use strict';
const { Resend } = require('resend');
const TurndownService = require('turndown');
const { emojify } = require('discord-emoji-converter');
const auth = require('./authentication.js');
const bot = require('./bot.js');
const Discord = require('discord.js');
const escapeHtml = require('escape-html');

let resend = null;
if (process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
}
const turndownService = new TurndownService();

const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'mail.discross.net';

// Sends a verification code via email (like pictocard)
exports.sendVerificationEmail = async function (recipientEmail, code, displayName) {
    const html = `
    <div style="background:#1A1A1E;color:#DCDCDF;font-family:'rodin',Helvetica,sans-serif;padding:40px;border-radius:8px;max-width:480px;margin:auto;">
      <h2 style="color:#5865f2;margin-top:0;">Discross Mail Verification</h2>
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Use the code below to verify your email and setup your Discross mail account. It expires in <strong>10 minutes</strong>.</p>
      <div style="background:#222327;border-radius:6px;padding:20px;text-align:center;font-size:36px;letter-spacing:12px;font-weight:bold;color:#5865f2;margin:24px 0;">
        ${escapeHtml(code)}
      </div>
      <p style="color:#6C6D76;font-size:13px;">If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

    try {
        if (!resend) {
            return {
                success: false,
                error: 'Email sending is disabled because RESEND_API_KEY is not set.',
            };
        }
        const data = await resend.emails.send({
            from: `Discross <noreply@${EMAIL_DOMAIN}>`,
            to: recipientEmail,
            subject: `${code} is your Discross Mail verification code`,
            html: html,
        });
        return { success: true, data };
    } catch (error) {
        console.error('Resend Verification Error:', error);
        return { success: false, error: error.message };
    }
};

// Process inbound webhooks from Resend
exports.handleInboundWebhook = async function (req, res) {
    const payload = req.body;
    if (!payload) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid payload' }));
    }

    let emailData = null;
    const emailId = payload.data ? payload.data.email_id || payload.data.id : null;

    if (payload.type === 'email.received' && emailId) {
        if (!resend) {
            console.error('Resend client not initialized, cannot fetch email body');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Resend API key not configured' }));
        }
        try {
            const { data, error } = await resend.emails.receiving.get(emailId);
            if (error) {
                console.error('Failed to retrieve received email from Resend API:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Failed to retrieve email content' }));
            }
            emailData = data;
        } catch (err) {
            console.error('Failed to retrieve received email from Resend API:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Failed to retrieve email content' }));
        }
    } else {
        // Fallback if the payload already contains to/from directly
        emailData = payload;
    }

    // Extract fields robustly from root or nested data object
    const to = emailData ? (emailData.to || (emailData.data && emailData.data.to)) : null;
    const from = emailData ? (emailData.from || (emailData.data && emailData.data.from)) : null;
    const subject = emailData ? (emailData.subject || (emailData.data && emailData.data.subject)) : null;
    const text = emailData ? (emailData.text || (emailData.data && emailData.data.text)) : null;
    const html = emailData ? (emailData.html || (emailData.data && emailData.data.html)) : null;

    if (!emailData || !to || !from) {
        console.warn('Invalid email payload received or fetched:', JSON.stringify(emailData || payload, null, 2));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid payload: missing to/from' }));
    }

    const toAddresses = Array.isArray(to) ? to : [to];

    for (let toAddress of toAddresses) {
        const [prefix, domain] = toAddress.split('@');

        if (domain !== EMAIL_DOMAIN) continue;

        const user = auth.getMailUserByEmail(prefix);
        if (!user) {
            console.log(`Received email for unregistered prefix: ${prefix}`);
            continue; // Ignore unregistered emails
        }

        if (!user.active) {
            console.log(`Received email for opted-out user: ${prefix}`);
            continue; // User opted out
        }

        if (auth.isMailBlocked(user.discordID, from)) {
            console.log(`Email from ${from} is blocked by user ${prefix}`);
            continue;
        }

        // Convert HTML to Discord Markdown if possible, fallback to text
        let content = text || 'No content';
        if (html) {
            try {
                content = turndownService.turndown(html);
            } catch (e) {
                console.error('HTML to Markdown conversion failed', e);
            }
        }

        // Convert emojis back to Discord format if applicable, or just rely on unicode
        try {
            content = emojify(content);
        } catch (e) {}

        // Truncate if too long for Discord (2000 chars limit per message)
        let description = content;
        if (description.length > 4000) {
            description = description.substring(0, 3995) + '...';
        }

        const embed = new Discord.EmbedBuilder()
            .setTitle(subject ? subject.substring(0, 256) : 'No Subject')
            .setAuthor({ name: from })
            .setDescription(description || 'No content')
            .setColor('#5865F2')
            .setFooter({ text: `To: ${toAddress}` })
            .setTimestamp();

        // Handle attachments if resend webhook provides them
        const files = [];
        // Resend webhook doesn't pass raw attachments easily, but if they exist in payload:
        // (Depends on Resend webhook config, typically they might be links or base64)

        const row = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId(`mail_reply:${emailData.from}`)
                .setLabel('Reply')
                .setStyle(Discord.ButtonStyle.Primary),
            new Discord.ButtonBuilder()
                .setCustomId(`mail_block:${emailData.from}`)
                .setLabel('Block Sender')
                .setStyle(Discord.ButtonStyle.Danger),
            new Discord.ButtonBuilder()
                .setCustomId(`mail_delete`)
                .setLabel('Delete')
                .setStyle(Discord.ButtonStyle.Secondary)
        );

        try {
            const discordUser = await bot.client.users.fetch(user.discordID);
            if (discordUser) {
                await discordUser.send({ embeds: [embed], components: [row] });
            }
        } catch (e) {
            console.error(`Failed to send email DM to ${user.discordID}`, e);
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
};

// Send an outbound email (Reply)
exports.sendEmail = async function (discordID, toAddress, subject, textContent, attachments = []) {
    const user = auth.getMailUser(discordID);
    if (!user || !user.active) {
        return { success: false, error: 'You do not have an active mail account.' };
    }

    // Convert markdown to HTML basic formatting
    // For a fully robust solution, use markdown-it, but a simple replace works for now
    let htmlContent = escapeHtml(textContent)
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');

    try {
        htmlContent = emojify(htmlContent);
    } catch (e) {}

    try {
        if (!resend) {
            return {
                success: false,
                error: 'Email sending is disabled because RESEND_API_KEY is not set.',
            };
        }
        const data = await resend.emails.send({
            from: `${user.email_prefix} <${user.email_prefix}@${EMAIL_DOMAIN}>`,
            to: toAddress,
            subject: subject,
            html: htmlContent,
            text: textContent,
            attachments: attachments,
        });
        return { success: true, data };
    } catch (error) {
        console.error('Resend Send Error:', error);
        return { success: false, error: error.message };
    }
};
