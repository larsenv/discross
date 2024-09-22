exports.toggleImages = async function toggleImages(req, res) {
    try {
        const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
        let imagesToggle = 1
        imagesCookie == 1 ? imagesToggle = 0 : imagesToggle = 1
        const referer = req.headers.referer || "/server"
        res.writeHead(302, { 'Set-Cookie': [`images=${imagesCookie == 1 ? 0 : 1}; path=/`], "Content-Type": "text/html", "Location": referer});   
        res.end()
    } catch (error) {
        res.writeHead(302, { "Location": "/server/" });
        res.end();
    }
}
