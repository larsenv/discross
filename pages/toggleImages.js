exports.toggleImages = async function toggleImages(req, res) {
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlImages = parsedUrl.searchParams.get('images');
    const imagesCookie = req.headers.cookie
      ?.split('; ')
      ?.find((cookie) => cookie.startsWith('images='))
      ?.split('=')[1];

    // URL param takes priority over cookie for determining current images state
    // Validate URL param is a valid images value (0 or 1)
    let parsedUrlImages = urlImages !== null ? parseInt(urlImages) : null;
    if (
      parsedUrlImages !== null &&
      (isNaN(parsedUrlImages) || (parsedUrlImages !== 0 && parsedUrlImages !== 1))
    ) {
      parsedUrlImages = null;
    }
    const currentValue =
      parsedUrlImages !== null
        ? parsedUrlImages
        : imagesCookie !== undefined
          ? parseInt(imagesCookie)
          : 1;
    const newValue = currentValue === 1 ? 0 : 1;

    const referer = req.headers.referer || '/server/';
    const refererUrl = new URL(referer, 'http://dummy.local');
    refererUrl.searchParams.set('images', newValue);
    const location = refererUrl.pathname + refererUrl.search;

    res.writeHead(302, {
      'Set-Cookie': [`images=${newValue}; path=/`],
      'Content-Type': 'text/html',
      Location: location,
    });
    res.end();
  } catch (error) {
    res.writeHead(302, { Location: '/server/' });
    res.end();
  }
};
