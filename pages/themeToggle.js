exports.toggleTheme = async function toggleTheme(req, res) {
    try {
        const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1]
        const referer = req.headers.referer || "/server"
        res.writeHead(302, { 'Set-Cookie': [`whiteThemeCookie=${whiteThemeCookie == 1 ? 0 : 1}; path=/`], "Content-Type": "text/html", "Location": referer}); 

        res.end()
    } catch (error) {
        res.writeHead(302, { "Location": "/server/" });
        res.end();
    }
}