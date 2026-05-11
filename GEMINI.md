# Discross Project Standards

## HTML Formatting
To ensure compatibility with older browsers and maintain readability, follow these standards for HTML files in `pages/templates/`:

- **Tag Consolidations:** Keep HTML tags (e.g., `<font>`, `<a>`, `<img>`, `<div>`, etc.) and their immediate text content on a single line whenever practical. All attributes and the closing bracket `>` or `/>` must be on the same line as the opening tag name. Avoid dangling `>` or `/>` on new lines.
  - **Good:** `<a class="btn" href="/">Link</a>`
  - **Bad:** 
    ```html
    <a
      class="btn"
      href="/"
    >Link</a
    >
    ```
- **Prettier Ignore:** HTML files in `pages/templates/` are ignored by Prettier (`.prettierignore`) to prevent the formatter from breaking custom template tags like `{$VAR}` and to avoid \"ugly\" whitespace-sensitive splitting that degrades the experience on older browsers.
- **Manual Formatting:** Since these files are ignored by Prettier, please ensure manual formatting remains clean and consistent with the existing style.

## Naming Conventions
- **JavaScript:** All JavaScript filenames must use camelCase (e.g., `setup2FA.js`, `errorReadingData.js`).
- **HTML:** All HTML filenames in `pages/templates/` must use kebab-case (e.g., `setup-2fa.html`, `error-reading-data.html`).
- **CSS/Images:** Keep existing conventions for static assets.

## Templating
- Use `{$VARIABLE_NAME}` for template substitutions.
- Common head elements are included via `{$COMMON_HEAD}`.

