/**
 * Hover tips like the viewer's (packages/viewer/src/ui/bindUi.js bindHoverTips): one floating
 * `#hover-tip`, centred above the control (below when there is no room), kept inside the window.
 * Native `title` attributes are moved to `data-tip` as they appear, so the rest of the app keeps
 * setting `title` and gets the styled tip instead of the browser's.
 */
export function bindHoverTips(): void {
  const tip = document.createElement('div');
  tip.id = 'hover-tip';
  tip.hidden = true;
  document.body.append(tip);
  let anchor: Element | null = null;

  const adopt = (el: Element): void => {
    const title = el.getAttribute('title');
    if (title === null) return;
    el.removeAttribute('title');
    if (title) el.setAttribute('data-tip', title);
    if (el === anchor) show(el);
  };
  const adoptTree = (root: Element): void => {
    adopt(root);
    root.querySelectorAll('[title]').forEach(adopt);
  };
  adoptTree(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target instanceof Element) adopt(r.target);
      else r.addedNodes.forEach((n) => { if (n instanceof Element) adoptTree(n); });
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  function show(next: Element): void {
    anchor = next;
    tip.textContent = next.getAttribute('data-tip') ?? '';
    tip.hidden = false;
    const margin = 8;
    const gap = 8;
    const rect = next.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left = rect.left + (rect.width - width) / 2;
    let top = rect.top - height - gap;
    if (top < margin) top = rect.bottom + gap;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  function hide(): void {
    anchor = null;
    tip.hidden = true;
  }

  document.addEventListener('mouseover', (event) => {
    if (!(event.target instanceof Element)) return;
    const next = event.target.closest('[data-tip]');
    if (next && next !== anchor) show(next);
  });
  document.addEventListener('mouseout', (event) => {
    if (!anchor) return;
    const to = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (to && anchor.contains(to)) return;
    const next = to instanceof Element ? to.closest('[data-tip]') : null;
    if (next && next !== anchor) show(next);
    else hide();
  });
  // Clicking usually changes or removes the control; do not leave a stale tip behind.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', () => { if (anchor) show(anchor); }, true);
  window.addEventListener('resize', () => { if (anchor) show(anchor); });
}
