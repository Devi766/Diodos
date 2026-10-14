import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useElementVisible } from '@/hooks/useElementVisible';
import { useIsDarkMode } from '@/hooks/useIsDarkMode';
import { cameraFor, greatCircle, loadLandDots, rad, vector, type Vec3 } from '@/lib/route-globe';
import type { RoutePoint } from '@/lib/route-trace';

const COUNTRIES = [
  [35, 105, '中国', 'China'], [36, 138, '日本', 'Japan'], [23.5, 121, '台湾', 'Taiwan'],
  [2, 104, '新加坡', 'Singapore'], [22, 79, '印度', 'India'], [39, -99, '美国', 'USA'],
  [55, -106, '加拿大', 'Canada'], [51, 10, '德国', 'Germany'], [-25, 135, '澳大利亚', 'Australia'],
] as const;

export function RouteGlobe({ points, destination, running, interactive = true, animate = true }: {
  points: RoutePoint[]; destination?: RoutePoint; running: boolean; interactive?: boolean; animate?: boolean;
}) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.startsWith('zh');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visible = useElementVisible(canvasRef);
  const dark = useIsDarkMode();
  const [land, setLand] = useState<RoutePoint[]>([]);
  const view = useRef({ lat: 25, lon: 110, zoom: 1, auto: true, vx: 0, vy: 0 });
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const flyStarted = useRef(0);
  const projectedLand = useRef<{ key: string; groups: Array<Array<{ x: number; y: number }>> }>({ key: '', groups: [] });
  const invalidate = useRef<() => void>(() => {});
  const vectors = useMemo(() => land.map(vector), [land]);
  const route = useMemo(() => points.map(vector), [points]);
  const target = useMemo(() => cameraFor(running ? points.slice(-2) : [...points, ...(destination ? [destination] : [])]), [points, destination, running]);
  const flightKey = points.slice(-2).map(point => `${point.lat}:${point.lon}`).join('|');
  useEffect(() => { if (animate && running && flightKey) flyStarted.current = performance.now(); }, [animate, running, flightKey]);
  useEffect(() => { let live = true; void loadLandDots().then(data => { if (live) setLand(data); }).catch(() => {}); return () => { live = false; }; }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const labelFont = getComputedStyle(canvas).fontFamily;
    let frame = 0; let last = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = (time: number) => {
      frame = 0;
      if (!visible) return;
      if (time - last < 32) { frame = requestAnimationFrame(draw); return; }
      last = time;
      const width = canvas.clientWidth; const height = canvas.clientHeight;
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      const current = view.current;
      let moving = false;
      if (current.auto) {
        if (!animate || reducedMotion) Object.assign(current, target);
        const flight = animate && !reducedMotion && running ? Math.max(0, Math.min(1, (time - flyStarted.current) / 900)) : 1;
        const zoomGoal = target.zoom * (1 - 0.22 * Math.sin(flight * Math.PI));
        const deltaLon = ((target.lon - current.lon + 540) % 360) - 180;
        moving = flight < 1 || Math.abs(deltaLon) + Math.abs(target.lat - current.lat) + Math.abs(zoomGoal - current.zoom) > 0.02;
        current.lon += deltaLon * 0.08; current.lat += (target.lat - current.lat) * 0.08;
        current.zoom += (zoomGoal - current.zoom) * 0.08;
      } else if (!dragging.current) {
        current.lon += current.vx; current.lat = Math.max(-80, Math.min(80, current.lat + current.vy));
        current.vx *= 0.91; current.vy *= 0.91; moving = Math.abs(current.vx) + Math.abs(current.vy) > 0.01;
      }
      const radius = Math.min(width * 0.48, height * 0.61) * current.zoom;
      const cx = width / 2; const cy = height / 2 + height * 0.12;
      const lat = rad(current.lat); const lon = rad(current.lon);
      const cosLat = Math.cos(lat); const sinLat = Math.sin(lat); const cosLon = Math.cos(lon); const sinLon = Math.sin(lon);
      const accent = dark ? '#40CBE0' : '#30B0C7';
      const project = (v: Vec3, lift = 1) => {
        const x = v[0] * cosLon - v[2] * sinLon;
        const z0 = v[0] * sinLon + v[2] * cosLon;
        const y = v[1] * cosLat - z0 * sinLat;
        const z = v[1] * sinLat + z0 * cosLat;
        return { x: cx + x * radius * lift, y: cy - y * radius * lift, z };
      };
      const shade = ctx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.5, 0, cx, cy, radius);
      shade.addColorStop(0, dark ? 'rgba(255,255,255,.035)' : 'rgba(110,125,140,.035)');
      shade.addColorStop(1, dark ? 'rgba(255,255,255,.005)' : 'rgba(110,125,140,.005)');
      ctx.fillStyle = shade; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 0.6; ctx.strokeStyle = dark ? 'rgba(255,255,255,.05)' : 'rgba(60,70,80,.06)'; ctx.stroke();
      const landKey = `${width}:${height}:${current.lat.toFixed(3)}:${current.lon.toFixed(3)}:${current.zoom.toFixed(4)}:${vectors.length}`;
      if (projectedLand.current.key !== landKey) {
        const groups: Array<Array<{ x: number; y: number }>> = [[], [], []];
        for (const v of vectors) { const p = project(v); if (p.z > 0) groups[Math.min(2, Math.floor(p.z * 3))].push(p); }
        projectedLand.current = { key: landKey, groups };
      }
      for (let depth = 0; depth < 3; depth++) {
        ctx.fillStyle = dark ? `rgba(200,205,210,${[0.18, 0.38, 0.65][depth]})` : `rgba(100,108,116,${[0.16, 0.32, 0.55][depth]})`;
        ctx.beginPath();
        for (const p of projectedLand.current.groups[depth]) {
          ctx.moveTo(p.x + 1, p.y); ctx.arc(p.x, p.y, Math.max(0.65, Math.min(1.5, radius / 130)), 0, Math.PI * 2);
        }
        ctx.fill();
      }
      const drawArc = (a: Vec3, b: Vec3, dashed: boolean) => {
        ctx.setLineDash(dashed ? [3, 5] : []); ctx.strokeStyle = accent; ctx.lineWidth = 1.3; ctx.globalAlpha = dashed ? 0.55 : 0.8;
        ctx.beginPath(); let pen = false;
        for (let i = 0; i <= 64; i++) {
          const p = project(greatCircle(a, b, i / 64), 1 + 0.035 * Math.sin(Math.PI * i / 64));
          if (p.z <= 0) { pen = false; continue; }
          if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); pen = true;
        }
        ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        for (let j = 0; j < 5; j++) {
          const p = project(greatCircle(a, b, ((time / 3200 + j / 5) % 1)), 1.025);
          if (p.z > 0) { ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2); ctx.fill(); }
        }
      };
      for (let i = 1; i < route.length; i++) drawArc(route[i - 1], route[i], Boolean(points[i].hidden));
      if (destination) {
        const end = vector(destination); const lastPoint = points[points.length - 1];
        if (route.length && (!lastPoint || Math.abs(lastPoint.lat - destination.lat) + Math.abs(lastPoint.lon - destination.lon) > 0.1)) drawArc(route[route.length - 1], end, true);
        const p = project(end); if (p.z > 0) { ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke(); }
      }
      const labels: Array<{ x: number; y: number; w: number; h: number }> = [];
      const label = (text: string, x: number, y: number, color: string) => {
        ctx.font = `10px ${labelFont}`; const w = ctx.measureText(text).width + 8; const h = 17;
        const box = { x: Math.max(3, Math.min(width - w - 3, x)), y: y - h / 2, w, h };
        if (box.y < 2 || box.y + h > height - 2 || labels.some(b => box.x < b.x + b.w + 4 && box.x + w + 4 > b.x && box.y < b.y + b.h + 3 && box.y + h + 3 > b.y)) return;
        labels.push(box); ctx.fillStyle = dark ? 'rgba(42,42,42,.8)' : 'rgba(255,255,255,.85)';
        ctx.beginPath(); ctx.roundRect(box.x, box.y, w, h, 7); ctx.fill();
        ctx.fillStyle = color; ctx.fillText(text, box.x + 4, box.y + 12);
      };
      for (const point of [...points].reverse()) {
        const p = project(vector(point)); if (p.z <= 0) continue;
        ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
        if (point.label) label(point.label, p.x + 7, p.y, accent);
      }
      if (radius > 75) for (const [lat, lon, zh, en] of COUNTRIES) {
        const p = project(vector({ lat, lon })); if (p.z > 0.45) label(chinese ? zh : en, p.x - 10, p.y, dark ? '#aeb0b4' : '#8e8e93');
      }
      if (moving || (animate && !reducedMotion && route.length > 1)) frame = requestAnimationFrame(draw);
    };
    const redraw = () => { if (visible && !frame) frame = requestAnimationFrame(draw); };
    invalidate.current = redraw;
    const observer = new ResizeObserver(redraw); observer.observe(canvas); redraw();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); invalidate.current = () => {}; };
  }, [visible, dark, vectors, route, points, destination, running, target, chinese, animate]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || !interactive) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation(); view.current.auto = false;
      view.current.zoom = Math.max(0.6, Math.min(3, view.current.zoom * Math.exp(-event.deltaY * 0.001)));
      invalidate.current();
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [interactive]);

  return <canvas ref={canvasRef} className="absolute inset-0 size-full touch-none" aria-hidden
    onDoubleClick={() => { if (interactive) { view.current.auto = true; invalidate.current(); } }}
    onPointerDown={event => { if (!interactive) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); dragging.current = { x: event.clientX, y: event.clientY }; view.current.auto = false; view.current.vx = 0; view.current.vy = 0; }}
    onPointerMove={event => { if (!interactive || !dragging.current) return; const dx = event.clientX - dragging.current.x; const dy = event.clientY - dragging.current.y;
      view.current.lon -= dx * 0.4; view.current.lat = Math.max(-80, Math.min(80, view.current.lat + dy * 0.4)); view.current.vx = -dx * 0.2; view.current.vy = dy * 0.2;
      dragging.current = { x: event.clientX, y: event.clientY }; invalidate.current(); }}
    onPointerUp={event => { dragging.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); invalidate.current(); }}
    onPointerCancel={() => { dragging.current = null; invalidate.current(); }} />;
}
