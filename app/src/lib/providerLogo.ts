// Model provider logos (models.dev, fetched and checked by our backend, served by GET /logo/<id>) as
// mask icons in the text color, so the monochrome logos work in light and dark. One class per logo with
// its own rule: rows only set a class name, and no var() ends up in a mask property (see app.css `.mi::before`).

const classes = new Map<string, string>();
let sheet: HTMLStyleElement | null = null;

/** Classes for an icon element (`icon mi …` or a pill with `mi`): the provider's logo, else the model icon. */
export function logoClass(url: string | null | undefined): string {
  if (!url) return 'ui-model';
  let cls = classes.get(url);
  if (!cls) {
    cls = `pl-${classes.size}`;
    classes.set(url, cls);
    if (typeof document !== 'undefined') {
      sheet ??= document.head.appendChild(document.createElement('style'));
      // Our own URL (site + /logo/ + storage id); quotes and backslashes cannot occur, removed anyway.
      sheet.append(`.${cls}::before{mask-image:url("${url.replace(/["\\\n]/g, '')}")}\n`);
    }
  }
  return `plogo ${cls}`;
}
