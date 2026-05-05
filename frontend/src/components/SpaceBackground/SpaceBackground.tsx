import { useEffect, useRef } from 'react';
import whiteIconUrl from '../../assets/icon_ai-common_white.svg?url';
import colorfulIconUrl from '../../assets/icon_ai-common_colorful.svg?url';
import './SpaceBackground.css';

type Rgb = [number, number, number];

type Star = {
  x: number;
  y: number;
  depth: number;
  radius: number;
  baseAlpha: number;
  phase: number;
  twinkleSpeed: number;
  driftX: number;
  driftY: number;
  wobble: number;
  icon: boolean;
  iconSize: number;
  rotation: number;
  rotationSpeed: number;
};

type VisualTokens = {
  isDark: boolean;
  starRgb: Rgb;
  glowRgb: Rgb;
  starOpacity: number;
};

export type SpaceBackgroundProps = {
  className?: string;
  density?: number;
  intensity?: number;
  iconStarRatio?: number;
  speed?: number;
  seed?: number;
};

const DEFAULT_PROPS = {
  density: 1,
  intensity: 1,
  iconStarRatio: 0.1,
  speed: 1,
  seed: 20260505,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const wrap = (value: number, max: number) => ((value % max) + max) % max;

function mulberry32(seed: number) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseComputedRgb(value: string): Rgb | null {
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const parts = match[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0], parts[1], parts[2]];
}

function rgbToString(rgb: Rgb) {
  return `${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}`;
}

function resolveTokenColor(tokenName: string, fallback: string): Rgb {
  if (typeof window === 'undefined') return parseComputedRgb(fallback) ?? [255, 255, 255];
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const declaredValue = styles.getPropertyValue(tokenName).trim() || fallback;
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.color = declaredValue;
  const host = document.body || root;
  host.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return parseComputedRgb(resolved) ?? parseComputedRgb(fallback) ?? [255, 255, 255];
}

function readNumberToken(tokenName: string, fallback: number) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readVisualTokens(): VisualTokens {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    isDark,
    starRgb: resolveTokenColor('--space-star-color', isDark ? 'rgb(255, 255, 255)' : 'rgb(20, 86, 240)'),
    glowRgb: resolveTokenColor('--space-glow-color', isDark ? 'rgb(74, 130, 255)' : 'rgb(20, 86, 240)'),
    starOpacity: readNumberToken('--space-star-opacity', isDark ? 0.88 : 0.66),
  };
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function createStars(width: number, height: number, density: number, iconStarRatio: number, seed: number) {
  const random = mulberry32(seed + Math.round(width) * 13 + Math.round(height) * 17);
  const area = width * height;
  const count = Math.round(clamp(area * 0.00013 * density, 120, 520));
  return Array.from({ length: count }, () => {
    const depth = Math.pow(random(), 0.72);
    const near = depth > 0.74;
    const icon = random() < iconStarRatio && depth > 0.36;
    const direction = random() > 0.5 ? 1 : -1;
    return {
      x: random() * width,
      y: random() * height,
      depth,
      radius: lerp(0.35, near ? 1.75 : 1.35, depth),
      baseAlpha: lerp(0.2, 0.88, depth),
      phase: random() * Math.PI * 2,
      twinkleSpeed: lerp(0.35, 1.45, random()) * lerp(0.75, 1.25, depth),
      driftX: direction * lerp(0.18, 2.55, depth),
      driftY: (random() - 0.5) * lerp(0.08, 0.8, depth),
      wobble: lerp(0.6, 6.5, depth),
      icon,
      iconSize: lerp(7, 21, depth) * (icon ? lerp(0.88, 1.2, random()) : 1),
      rotation: random() * Math.PI * 2,
      rotationSpeed: (random() - 0.5) * 0.035,
    } satisfies Star;
  });
}

function addSoftGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rgb: Rgb, alpha: number) {
  const color = rgbToString(rgb);
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(${color}, ${clamp(alpha, 0, 1)})`);
  gradient.addColorStop(0.35, `rgba(${color}, ${clamp(alpha * 0.42, 0, 1)})`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawDotStar(ctx: CanvasRenderingContext2D, star: Star, x: number, y: number, alpha: number, visual: VisualTokens) {
  const color = rgbToString(visual.starRgb);
  const glowRadius = star.radius * lerp(4.4, 7.8, star.depth);
  addSoftGlow(ctx, x, y, glowRadius, visual.starRgb, alpha * 0.72);
  ctx.fillStyle = `rgba(${color}, ${clamp(alpha, 0, 1)})`;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.42, star.radius), 0, Math.PI * 2);
  ctx.fill();
  if (star.depth > 0.72) {
    const flareLength = star.radius * lerp(3.2, 5.8, star.depth);
    ctx.save();
    ctx.globalAlpha = clamp(alpha * 0.34, 0, 0.45);
    ctx.strokeStyle = `rgba(${color}, 1)`;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x - flareLength, y);
    ctx.lineTo(x + flareLength, y);
    ctx.moveTo(x, y - flareLength);
    ctx.lineTo(x, y + flareLength);
    ctx.stroke();
    ctx.restore();
  }
}

function drawVectorFourPointStar(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number, visual: VisualTokens) {
  const color = rgbToString(visual.starRgb);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = `rgba(${color}, ${clamp(alpha, 0, 1)})`;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.5);
  ctx.lineTo(size * 0.09, -size * 0.09);
  ctx.lineTo(size * 0.5, 0);
  ctx.lineTo(size * 0.09, size * 0.09);
  ctx.lineTo(0, size * 0.5);
  ctx.lineTo(-size * 0.09, size * 0.09);
  ctx.lineTo(-size * 0.5, 0);
  ctx.lineTo(-size * 0.09, -size * 0.09);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawIconStar(ctx: CanvasRenderingContext2D, star: Star, x: number, y: number, alpha: number, elapsedSeconds: number, visual: VisualTokens, image: HTMLImageElement | null) {
  const size = star.iconSize * lerp(0.92, 1.13, alpha);
  const glowRgb = visual.isDark ? visual.starRgb : visual.glowRgb;
  addSoftGlow(ctx, x, y, size * 1.9, glowRgb, alpha * 0.36);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(star.rotation + elapsedSeconds * star.rotationSpeed);
  ctx.globalAlpha = clamp(alpha * 1.16, 0, 1);
  if (image?.complete && image.naturalWidth > 0) {
    ctx.drawImage(image, -size / 2, -size / 2, size, size);
  } else {
    drawVectorFourPointStar(ctx, 0, 0, size, alpha, visual);
  }
  ctx.restore();
}

export function SpaceBackground(props: SpaceBackgroundProps) {
  const { className, density = DEFAULT_PROPS.density, intensity = DEFAULT_PROPS.intensity, iconStarRatio = DEFAULT_PROPS.iconStarRatio, speed = DEFAULT_PROPS.speed, seed = DEFAULT_PROPS.seed } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frameId = 0;
    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let visual = readVisualTokens();
    let whiteIcon: HTMLImageElement | null = null;
    let colorfulIcon: HTMLImageElement | null = null;
    let disposed = false;

    const render = (time: number, staticFrame = false) => {
      const elapsedSeconds = time / 1000;
      const motion = staticFrame ? 0 : speed;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
      const iconImage = visual.isDark ? whiteIcon : colorfulIcon;
      for (const star of stars) {
        const driftX = elapsedSeconds * star.driftX * motion;
        const driftY = elapsedSeconds * star.driftY * motion;
        const wobbleX = Math.sin(elapsedSeconds * 0.18 * motion + star.phase) * star.wobble;
        const wobbleY = Math.cos(elapsedSeconds * 0.13 * motion + star.phase) * star.wobble * 0.34;
        const x = wrap(star.x + driftX + wobbleX, width);
        const y = wrap(star.y + driftY + wobbleY, height);
        const twinkle = staticFrame ? 0.78 : 0.56 + 0.44 * Math.sin(elapsedSeconds * star.twinkleSpeed * motion + star.phase);
        const depthBoost = lerp(0.72, 1.18, star.depth);
        const alpha = clamp(star.baseAlpha * twinkle * visual.starOpacity * intensity * depthBoost, 0, 1);
        if (star.icon) drawIconStar(ctx, star, x, y, alpha, elapsedSeconds, visual, iconImage);
        else drawDotStar(ctx, star, x, y, alpha, visual);
      }
    };

    const start = () => {
      cancelAnimationFrame(frameId);
      if (document.hidden || motionQuery.matches) { render(performance.now(), true); return; }
      const tick = (time: number) => { render(time); frameId = requestAnimationFrame(tick); };
      frameId = requestAnimationFrame(tick);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = createStars(width, height, density, iconStarRatio, seed);
      visual = readVisualTokens();
      start();
    };

    const refreshTheme = () => {
      visual = readVisualTokens();
      render(performance.now(), motionQuery.matches || document.hidden);
      start();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

    motionQuery.addEventListener('change', start);
    document.addEventListener('visibilitychange', start);

    Promise.allSettled([loadImage(whiteIconUrl), loadImage(colorfulIconUrl)]).then((results) => {
      if (disposed) return;
      if (results[0].status === 'fulfilled') whiteIcon = results[0].value;
      if (results[1].status === 'fulfilled') colorfulIcon = results[1].value;
      render(performance.now(), motionQuery.matches || document.hidden);
    });

    resize();
    start();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      motionQuery.removeEventListener('change', start);
      document.removeEventListener('visibilitychange', start);
    };
  }, [density, iconStarRatio, intensity, speed, seed]);

  return (
    <div className={['ai-space-background', className].filter(Boolean).join(' ')} aria-hidden="true">
      <canvas ref={canvasRef} className="ai-space-background__canvas" />
    </div>
  );
}
