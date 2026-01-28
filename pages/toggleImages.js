exports.toggleImages = async function toggleImages(req, res) {
    try {
        const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
        // Default to 1 (on) if cookie doesn't exist, then toggle it
        const currentValue = imagesCookie !== undefined ? parseInt(imagesCookie) : 1;
        const newValue = currentValue === 1 ? 0 : 1;
        const referer = req.headers.referer || "/server"
        res.writeHead(302, { 'Set-Cookie': [`images=${newValue}; path=/`], "Content-Type": "text/html", "Location": referer});   
        res.end()
    } catch (error) {
        res.writeHead(302, { "Location": "/server/" });
        res.end();
    }
}
