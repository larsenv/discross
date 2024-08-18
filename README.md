<p align="center" dir="auto"><a href="https://discross.rc24.xyz/" rel="nofollow"><img src="https://github.com/user-attachments/assets/6839908d-c843-4e48-8f32-44b803080f0c" alt="Discross Logo" style="max-width: 100%;"></a></p>

**Discross** is a webhook bridge to send messages on Discord aiming to support all platforms that support HTML.

## Usage

1. Go to [discross.rc24.xyz](https://discross.rc24.xyz/) and use the [link](https://discordapp.com/oauth2/authorize?client_id=968999890640338955&scope=bot&permissions=8) to add Discross to your server.
2. Type `^connect` to get your verification code
3. Register on the website with that code
4. Click the "update your server list" button to authorize Discross with your Discord account

### Supported platforms
Platforms that are confirmed to work, to some extent:

* Nintendo 3DS
* Nintendo DS
* Nintendo DSi
* Nintendo Switch
* PlayStation 3
* PlayStation 4
* PlayStation 5
* PlayStation Portable
* PlayStation Vita
* Sega Dreamcast
* Wii Internet Channel
* Wii U
* Windows 95
* Windows 98
* Windows XP
* Xbox 360
* Xbox One

## Hosting

Make sure the following are installed:

* Node.js
* Python
* Visual Studio Build Tools

```bash
git clone https://github.com/larsenv/discross.git
cd discross
mkdir secrets
touch database.db
touch token.txt
```

Go to [discord.dev](https://discord.com/developers/applications) and create a new application

In the application menu go to "Bot" and click on "Reset Token"

Copy the token and paste it into token.txt. Keep this token secure and never share it publicly, as it provides full access to your bot.

Copy the token and paste it into token.txt

Now invite the bot onto your server

Go to "OAuth2"

Click "Add Redirect" and type in `http://localhost:4000/discord.html`

Below, click "bot"

Select the redirect and choose the "Manage webhooks" permission

Copy the URL and paste it in a new tab to invite the bot

To authorize the bot with your Discord account (this has to be done every time you add a new server), deselect "bot" and tick "identify" and "guilds"

Copy the link again, but replace `response_type=code` with `response_type=token`

Paste the link into a new tab and press "Authorize"

```bash
node .
```

Open Discord and type ^connect in the same server you invited the bot in

The bot will send you a verification code in DMs

Go to [localhost:4000](http://localhost:4000) and use it to register

# Discross is made by [circuit10](https://github.com/Heath123) (Heath123 is circuit10's GitHub username)
