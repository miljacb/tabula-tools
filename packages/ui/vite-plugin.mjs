// Lets an app's index.html link shared stylesheets outside its root (`../ui/chrome.css`) as plain
// <link>s, which block first paint (no flash of unstyled page, as a CSS import from the script has).
// A build bundles such links as they are; the dev server does not serve files outside the root, so in
// dev this rewrites them to Vite's /@fs/ URL for the file (Vite adds the base).
import path from 'node:path';

export function sharedStyles() {
  return {
    name: 'tabula-shared-styles',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const dir = path.dirname(ctx.filename);
        return html.replace(/(<link\b[^>]*\bhref=")(\.\.\/[^"]+\.css)(")/g, (_, open, href, close) => `${open}/@fs${path.resolve(dir, href)}${close}`);
      },
    },
  };
}
