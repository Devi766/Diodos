// 网络速度曲线：下载一条带渐变填充的主线，上传一条同色低透明度细线，背后三道虚线刻度，
// 曲线头部带一圈光晕。曲线按时间连续向左滚动，头部沿着平滑曲线走向最新的数据点，
// 下一个点到来时正好接上。

export interface SpeedLinesSample {
  upSpeed: number;
  downSpeed: number;
}

export interface SpeedLinesColors {
  line: string; // 主色，形如 "r, g, b"
  haloBase: string; // 头部光晕内圈底色（卡片底色）
  dark: boolean;
}

// 画面里同时显示的数据点数
const CAPACITY = 30;
// 平滑预热用的额外历史点数，保证左端起点也是稳定的
const WARMUP = 12;
// 指数平滑系数：越小越平滑、越滞后
const SMOOTHING = 0.45;
// 最小量程 16 KB/s，空闲时曲线贴着底部而不是被放大成噪声
const MIN_SCALE = 16 * 1024;
// 量程过渡的时间常数（毫秒）
const SCALE_EASING_MS = 260;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// 只看过去的指数平滑：新数据到来不会改动已经画出来的部分，曲线滚动时不会抖
function smoothCausal(values: number[]): number[] {
  if (values.length === 0) return values;
  const out = new Array<number>(values.length);
  let acc = values[0];
  for (let i = 0; i < values.length; i += 1) {
    acc += (values[i] - acc) * SMOOTHING;
    out[i] = acc;
  }
  // 只保留画面需要的点（多一个在头部右侧）
  return out.length > CAPACITY + 1 ? out.slice(out.length - CAPACITY - 1) : out;
}

// 量程取峰值的 1.25 倍，并对齐到 1/2/5 × 10^n，避免轻微波动导致曲线忽高忽低
function niceScale(peak: number): number {
  const wanted = Math.max(peak * 1.25, MIN_SCALE);
  let magnitude = 1;
  while (magnitude * 10 <= wanted) magnitude *= 10;
  for (const m of [1, 2, 5, 10]) {
    if (magnitude * m >= wanted) return magnitude * m;
  }
  return magnitude * 10;
}

const sameValues = (a: number[], b: number[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

interface CurvePoints {
  xs: number[];
  ys: number[];
  slopes: number[];
}

// 单调三次插值（Fritsch–Carlson）：曲线经过每个数据点，转折圆润，
// 相邻两点之间不会冲出它们的高低范围（峰值附近不鼓包，也不会低于 0）
function monotoneCurve(xs: number[], ys: number[]): { path: Path2D; points: CurvePoints } {
  const n = xs.length;
  const path = new Path2D();
  const m = new Array<number>(n).fill(0);
  path.moveTo(xs[0], ys[0]);
  if (n < 2) return { path, points: { xs, ys, slopes: m } };

  let prev = (ys[1] - ys[0]) / (xs[1] - xs[0]);
  m[0] = prev;
  for (let i = 1; i < n - 1; i += 1) {
    const d = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    m[i] = prev * d <= 0 ? 0 : (prev + d) / 2;
    prev = d;
  }
  m[n - 1] = prev;
  for (let i = 0; i < n - 1; i += 1) {
    const d = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    if (d === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d;
    const b = m[i + 1] / d;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d;
      m[i + 1] = t * b * d;
    }
  }
  for (let i = 0; i < n - 1; i += 1) {
    const h = (xs[i + 1] - xs[i]) / 3;
    path.bezierCurveTo(
      xs[i] + h, ys[i] + m[i] * h,
      xs[i + 1] - h, ys[i + 1] - m[i + 1] * h,
      xs[i + 1], ys[i + 1],
    );
  }
  return { path, points: { xs, ys, slopes: m } };
}

// 曲线最后一段在参数 t 处的高度（与绘制的三次曲线一致），即头部所在位置
function lastSegmentYAt({ xs, ys, slopes }: CurvePoints, t: number): number {
  const n = ys.length;
  if (n < 2) return ys[0] ?? 0;
  const i = n - 2;
  const h = xs[i + 1] - xs[i];
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i]
    + (t3 - 2 * t2 + t) * h * slopes[i]
    + (-2 * t3 + 3 * t2) * ys[i + 1]
    + (t3 - t2) * h * slopes[i + 1];
}

export class SpeedLinesRenderer {
  private download: number[] = [];
  private upload: number[] = [];
  // 最近一个数据点到达的时间，以及估计的数据间隔
  private lastArrival = 0;
  private interval: number;
  private scale = MIN_SCALE;
  private targetScale = MIN_SCALE;
  private lastFrame = 0;

  constructor(expectedInterval = 1500) {
    this.interval = expectedInterval;
  }

  // 更新数据（字节 / 秒，按时间顺序）。animate 为 false 时直接停在最新点上，不滚动
  setSamples(samples: SpeedLinesSample[], animate: boolean, now: number): boolean {
    const history = samples.slice(-(CAPACITY + WARMUP));
    const nextUpload = smoothCausal(history.map((sample) => Math.max(0, sample.upSpeed)));
    const nextDownload = smoothCausal(history.map((sample) => Math.max(0, sample.downSpeed)));
    if (sameValues(nextDownload, this.download) && sameValues(nextUpload, this.upload)) return false;

    if (animate && this.lastArrival > 0) {
      // 用实际到达间隔校准滚动速度，偶发的延迟不会让曲线忽快忽慢
      const gap = now - this.lastArrival;
      if (gap >= 300 && gap <= 5000) this.interval = this.interval * 0.7 + gap * 0.3;
      this.lastArrival = now;
    } else {
      // 静态展示：当作上一个间隔已经走完，头部正好停在最新点
      this.lastArrival = now - this.interval;
    }
    this.download = nextDownload;
    this.upload = nextUpload;

    const peak = Math.max(0, ...nextDownload, ...nextUpload);
    this.targetScale = niceScale(peak);
    if (!animate) this.scale = this.targetScale;
    return true;
  }

  // 绘制一帧，返回是否需要继续逐帧刷新（数据仍在流动或量程仍在过渡）
  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    insetTop: number,
    insetBottom: number,
    colors: SpeedLinesColors,
    now: number,
  ): boolean {
    ctx.clearRect(0, 0, width, height);
    const top = insetTop;
    const bottom = height - insetBottom;
    if (width <= 0 || bottom <= top) return false;
    const chartHeight = bottom - top;

    // 量程每帧向目标值靠近，过渡平滑
    const dt = this.lastFrame === 0 ? 16 : clamp(now - this.lastFrame, 0, 100);
    this.lastFrame = now;
    this.scale += (this.targetScale - this.scale) * (1 - Math.exp(-dt / SCALE_EASING_MS));
    const scaleSettled = Math.abs(this.targetScale - this.scale) < this.targetScale * 0.002;
    if (scaleSettled) this.scale = this.targetScale;

    const rgba = (alpha: number) => `rgba(${colors.line}, ${alpha})`;

    ctx.save();
    ctx.strokeStyle = rgba(colors.dark ? 0.14 : 0.1);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    for (let k = 1; k <= 3; k += 1) {
      const y = Math.round(top + (chartHeight * k) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    const n = this.download.length;
    if (n < 2) {
      this.lastFrame = 0;
      return false;
    }

    // 头部位于倒数第二个点和最新点之间，按时间推进
    const progress = clamp((now - this.lastArrival) / this.interval, 0, 1);
    const step = width / (CAPACITY - 1);
    const headX = width - 10;
    const xOf = (i: number) => headX - (n - 2 + progress - i) * step;
    const yOf = (value: number) => bottom - clamp(value / this.scale, 0, 1) * chartHeight;

    const xs = Array.from({ length: n }, (_, i) => xOf(i));
    const uploadCurve = monotoneCurve(xs, this.upload.map(yOf));
    const downloadCurve = monotoneCurve(xs, this.download.map(yOf));
    const headY = lastSegmentYAt(downloadCurve.points, progress);

    ctx.save();
    // 最新点还在头部右侧，裁掉，看起来就是头部在连续往前走
    ctx.beginPath();
    ctx.rect(0, 0, headX, height);
    ctx.clip();

    const fill = new Path2D(downloadCurve.path);
    fill.lineTo(xs[n - 1], bottom);
    fill.lineTo(xs[0], bottom);
    fill.closePath();
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, rgba(0.18));
    gradient.addColorStop(1, rgba(0));
    ctx.fillStyle = gradient;
    ctx.fill(fill);
    ctx.restore();

    // 头部右侧给光晕留出的空隙按头部高度补齐填充，填充一直铺到右边缘
    ctx.fillStyle = gradient;
    ctx.fillRect(headX, headY, width - headX, bottom - headY);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, headX, height);
    ctx.clip();

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(0.35);
    ctx.lineWidth = 1.4;
    ctx.stroke(uploadCurve.path);
    ctx.strokeStyle = rgba(1);
    ctx.lineWidth = 2.2;
    ctx.stroke(downloadCurve.path);
    ctx.restore();

    // 头部：光晕 + 底色描边 + 实心点
    const dot = (radius: number, color: string) => {
      ctx.beginPath();
      ctx.arc(headX, headY, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    dot(7, rgba(0.16));
    dot(4, colors.haloBase);
    dot(2.6, rgba(1));

    const flowing = now - this.lastArrival < this.interval * 2.5;
    if (flowing || !scaleSettled) return true;
    this.lastFrame = 0;
    return false;
  }
}
