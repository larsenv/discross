exports.toggleTheme = async function toggleTheme(req, res) {
    try {
        const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='));
        let whiteThemeToggle = 1
        const whiteThemeCookieValue = whiteThemeCookie?.split('=')[1]
        whiteThemeCookieValue == 1 ? whiteThemeToggle = 0 : whiteThemeToggle = 1
        const referer = req.headers.referer || "/server"
        res.writeHead(302, { 'Set-Cookie': [`whiteThemeCookie=${whiteThemeToggle}; path=/`], "Content-Type": "text/html", "Location": referer});   
        res.end()
    } catch (error) {
        res.writeHead(302, { "Location": "/server/" });
        res.end();
    }
}