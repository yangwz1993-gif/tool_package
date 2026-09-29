// Pure viewport math; the diagram's node and edge coordinates stay unchanged.
export function orderedSections(view) {
  const direction = view.autoLayout?.direction ?? 'TB';
  return view.nodes.filter(n => n.kind === '@group').sort((a,b) => {
    if (direction === 'LR') return a.x - b.x || a.y - b.y;
    if (direction === 'RL') return b.x - a.x || a.y - b.y;
    if (direction === 'BT') return b.y - a.y || a.x - b.x;
    return a.y - b.y || a.x - b.x;
  });
}

export function readingViewport(bounds, viewportWidth, zoom, anchor = bounds, direction = 'TB') {
  const width = Math.max(1, viewportWidth);
  const inset = 32;
  return {
    x: Math.max(inset, (width - anchor.width * zoom) / 2) - anchor.x * zoom,
    // Horizontal navigation keeps outer return lanes above the panels visible.
    y: inset - (['LR','RL'].includes(direction) ? bounds.y : anchor.y) * zoom,
    zoom,
  };
}
