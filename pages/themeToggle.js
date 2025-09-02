exports.toggleTheme = async function toggleTheme(req, res) {
    try {
        const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1]
        const referer = req.headers.referer || "/server"
        
        // Cycle through themes: 0 (dark) -> 1 (light) -> 2 (amoled) -> 0 (dark)
        let nextTheme = 0;
        if (whiteThemeCookie == 0 || whiteThemeCookie === undefined) {
            nextTheme = 1; // dark -> light
        } else if (whiteThemeCookie == 1) {
            nextTheme = 2; // light -> amoled
        } else if (whiteThemeCookie == 2) {
            nextTheme = 0; // amoled -> dark
        }
        
        res.writeHead(302, { 'Set-Cookie': [`whiteThemeCookie=${nextTheme}; path=/`], "Content-Type": "text/html", "Location": referer}); 

        res.end()
    } catch (error) {
        res.writeHead(302, { "Location": "/server/" });
        res.end();
    }
}