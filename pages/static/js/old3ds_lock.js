// Aggressive layout lock for Old 3DS
if (
    navigator.userAgent.indexOf('Nintendo 3DS') !== -1 &&
    navigator.userAgent.indexOf('NintendoBrowser') === -1
) {
    document.write(
        '<style>body, html { width: 320px !important; height: 240px !important; overflow: hidden !important; position: fixed !important; }</style>'
    );
}
