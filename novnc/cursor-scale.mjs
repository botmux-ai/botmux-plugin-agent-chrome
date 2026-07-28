export function cursorDisplayScale(canvasWidth, canvasHeight, displayWidth, displayHeight) {
  const scales = [];
  if (canvasWidth > 0 && displayWidth > 0) scales.push(displayWidth / canvasWidth);
  if (canvasHeight > 0 && displayHeight > 0) scales.push(displayHeight / canvasHeight);
  if (scales.length === 0) return 1;
  return Math.max(0.05, Math.min(4, Math.min(...scales)));
}

export function scaledCursorGeometry(width, height, hotX, hotY, scale) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const scaledWidth = Math.max(1, Math.round(width * safeScale));
  const scaledHeight = Math.max(1, Math.round(height * safeScale));
  return {
    width: scaledWidth,
    height: scaledHeight,
    hotX: Math.max(0, Math.min(scaledWidth - 1, Math.round(hotX * safeScale))),
    hotY: Math.max(0, Math.min(scaledHeight - 1, Math.round(hotY * safeScale))),
  };
}
