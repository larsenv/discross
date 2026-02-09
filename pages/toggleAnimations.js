exports.toggleAnimations = async function toggleAnimations(req, res) {
    try {
        const animationsCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('animations='))?.split('=')[1];
        // Default to 1 (on) if cookie doesn't exist, then toggle it
        const currentValue = animationsCookie !== undefined ? parseInt(animationsCookie) : 1;
        const newValue = currentValue === 1 ? 0 : 1;
        const referer = req.headers.referer || "/server"
        res.writeHead(302, { 'Set-Cookie': [`animations=${newValue}; path=/`], "Content-Type": "text/html", "Location": referer});   
        res.end()
    } catch (error) {
        res.writeHead(302, { "Location": "/server/" });
        res.end();
    }
}
