import { useId } from "react";

/**
 * Aiko, Acorn's companion: a tiny acorn with a leafy-green cap, big shiny eyes, blushing cheeks, little arms and feet.
 * One drawing, nine moods. Everything is inline SVG (no images to break during a demo) and every animation is plain CSS
 * (see globals.css), switched off under prefers-reduced-motion.
 */
export type Mood = "happy" | "curious" | "thinking" | "reading" | "learning" | "celebrating" | "sleeping" | "confused" | "encouraging";
export type Motion = "idle" | "float" | "think" | "jump" | "celebrate" | "sleep" | "none";

const DEFAULT_MOTION: Record<Mood, Motion> = {
  happy: "idle",
  curious: "float",
  thinking: "think",
  reading: "float",
  learning: "idle",
  celebrating: "celebrate",
  sleeping: "sleep",
  confused: "think",
  encouraging: "idle",
};

const MOTION_CLASS: Record<Motion, string> = {
  idle: "aiko-idle",
  float: "aiko-float",
  think: "aiko-think",
  jump: "aiko-jump",
  celebrate: "aiko-celebrate",
  sleep: "aiko-sleep",
  none: "",
};

const C = {
  body: "#f6c98b",
  bodyDeep: "#e9a867",
  belly: "#fce6c0",
  cap: "#7cb24a",
  capDeep: "#639a38",
  capHatch: "#4f8430",
  stem: "#8a6240",
  leaf: "#a5d36a",
  eye: "#25361f",
  cheek: "#f4907c",
  mouth: "#b5483c",
  page: "#fffdf6",
  book: "#9f8ee0",
  bookDeep: "#7d6cc4",
  spark: "#f7d56a",
};

function Sparkle({ x, y, s = 1, delay = 0 }: { x: number; y: number; s?: number; delay?: number }) {
  return (
    <path
      className="aiko-pop"
      style={{ animationDelay: `${delay}s` }}
      transform={`translate(${x} ${y}) scale(${s})`}
      d="M0 -7 C1 -2 2 -1 7 0 C2 1 1 2 0 7 C-1 2 -2 1 -7 0 C-2 -1 -1 -2 0 -7Z"
      fill={C.spark}
      stroke="#e3b93f"
      strokeWidth="0.8"
      strokeLinejoin="round"
    />
  );
}

function Eyes({ mood }: { mood: Mood }) {
  const stroke = { stroke: C.eye, strokeWidth: 3.4, strokeLinecap: "round" as const, fill: "none" };
  if (mood === "celebrating") {
    return (
      <>
        <path d="M57 103 Q65 93 73 103" {...stroke} />
        <path d="M87 103 Q95 93 103 103" {...stroke} />
      </>
    );
  }
  if (mood === "sleeping") {
    return (
      <>
        <path d="M57 101 Q65 108 73 101" {...stroke} />
        <path d="M87 101 Q95 108 103 101" {...stroke} />
      </>
    );
  }
  // open eyes: a dark pupil with two shiny highlights. The look direction and size change per mood.
  const look: Record<string, [number, number]> = {
    thinking: [3, -3],
    reading: [0, 3.5],
    learning: [0, -1],
    curious: [2, -1],
    confused: [-1, 0],
  };
  const [dx, dy] = look[mood] ?? [0, 0];
  const rl = mood === "curious" ? 6.6 : 7.6;
  const rr = mood === "curious" ? 8.8 : 7.6;
  return (
    <g className="aiko-blink">
      <circle cx={65 + dx} cy={100 + dy} r={rl} fill={C.eye} />
      <circle cx={95 + dx} cy={100 + dy} r={rr} fill={C.eye} />
      <circle cx={67.8 + dx} cy={97.2 + dy} r="2.7" fill="#fff" />
      <circle cx={62.4 + dx} cy={103.4 + dy} r="1.2" fill="#fff" opacity=".85" />
      <circle cx={98 + dx} cy={96.8 + dy} r="2.9" fill="#fff" />
      <circle cx={92.4 + dx} cy={103.4 + dy} r="1.2" fill="#fff" opacity=".85" />
    </g>
  );
}

function Brows({ mood }: { mood: Mood }) {
  const s = { stroke: C.eye, strokeWidth: 2.6, strokeLinecap: "round" as const, fill: "none" };
  if (mood === "curious") return <path d="M86 86 Q95 80 104 85" {...s} />;
  if (mood === "confused")
    return (
      <>
        <path d="M57 90 Q65 87 72 91" {...s} />
        <path d="M88 87 Q96 92 103 89" {...s} />
      </>
    );
  if (mood === "thinking") return <path d="M88 88 Q96 84 104 88" {...s} />;
  return null;
}

function Mouth({ mood }: { mood: Mood }) {
  const line = { stroke: C.mouth, strokeWidth: 3, strokeLinecap: "round" as const, fill: "none" };
  switch (mood) {
    case "celebrating":
      return (
        <>
          <path d="M68 112 Q80 134 92 112 Q80 116 68 112Z" fill={C.mouth} stroke={C.mouth} strokeWidth="2" strokeLinejoin="round" />
          <path d="M73 121 Q80 126 87 121 Q80 118 73 121Z" fill="#f4907c" />
        </>
      );
    case "curious":
      return <ellipse cx="80" cy="118" rx="3.6" ry="4.2" fill={C.mouth} />;
    case "thinking":
      return <path d="M73 118 Q78 114 83 117 Q86 119 88 116" {...line} />;
    case "sleeping":
      return <ellipse cx="80" cy="117" rx="3" ry="2.4" fill={C.mouth} opacity=".8" />;
    case "confused":
      return <path d="M71 118 q4.5 -5 9 0 t9 0" {...line} />;
    case "encouraging":
      return <path d="M70 113 Q80 126 90 113" {...line} />;
    case "reading":
      return <path d="M75 115 Q80 119 85 115" {...line} />;
    default:
      return <path d="M71 113 Q80 123 89 113" {...line} />;
  }
}

function Arms({ mood }: { mood: Mood }) {
  const arm = (cx: number, cy: number, rot: number) => (
    <ellipse cx={cx} cy={cy} rx="8.5" ry="13" fill={C.body} stroke={C.bodyDeep} strokeWidth="1.4" transform={`rotate(${rot} ${cx} ${cy})`} />
  );
  switch (mood) {
    case "celebrating":
      return (
        <>
          {arm(36, 88, -35)}
          {arm(124, 88, 35)}
        </>
      );
    case "encouraging":
      return (
        <>
          {arm(38, 112, 18)}
          {arm(121, 92, 32)}
        </>
      );
    case "reading":
    case "learning":
      return (
        <>
          {arm(53, 126, -22)}
          {arm(107, 126, 22)}
        </>
      );
    case "thinking":
      return (
        <>
          {arm(38, 112, 18)}
          {arm(104, 123, 55)}
        </>
      );
    case "sleeping":
      return (
        <>
          {arm(40, 116, 10)}
          {arm(120, 116, -10)}
        </>
      );
    case "confused":
      return (
        <>
          {arm(37, 106, 28)}
          {arm(123, 106, -28)}
        </>
      );
    default:
      return (
        <>
          {arm(38, 112, 16)}
          {arm(122, 112, -16)}
        </>
      );
  }
}

function Props({ mood }: { mood: Mood }) {
  switch (mood) {
    case "reading":
    case "learning":
      return (
        <g>
          <path d="M52 126 Q66 120 80 127 Q94 120 108 126 L108 148 Q94 142 80 149 Q66 142 52 148Z" fill={C.book} stroke={C.bookDeep} strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M56 128 Q67 124 78 129 L78 144 Q67 139 56 143Z" fill={C.page} />
          <path d="M104 128 Q93 124 82 129 L82 144 Q93 139 104 143Z" fill={C.page} />
          <path d="M60 133 Q67 131 73 134 M60 138 Q67 136 73 139 M87 134 Q93 131 100 133 M87 139 Q93 136 100 138" stroke="#cfc3f0" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          {mood === "learning" && (
            <>
              <Sparkle x={132} y={62} s={1.2} />
              <Sparkle x={26} y={74} s={0.9} delay={0.5} />
              <Sparkle x={142} y={98} s={0.7} delay={0.9} />
            </>
          )}
        </g>
      );
    case "thinking":
      return (
        <g fill="#ece7fb" stroke="#b9a8e6" strokeWidth="1.5">
          <g className="aiko-dots">
            <circle className="aiko-dot" cx="128" cy="52" r="3.5" />
            <circle className="aiko-dot" cx="138" cy="40" r="5" />
            <circle className="aiko-dot" cx="150" cy="24" r="7" />
          </g>
        </g>
      );
    case "sleeping":
      return (
        <g fill={C.bookDeep} fontFamily="var(--font-rounded), system-ui" fontWeight="700">
          <text className="aiko-pop" x="118" y="52" fontSize="17">z</text>
          <text className="aiko-pop" style={{ animationDelay: ".5s" }} x="132" y="36" fontSize="13">z</text>
          <text className="aiko-pop" style={{ animationDelay: "1s" }} x="143" y="23" fontSize="10">z</text>
        </g>
      );
    case "confused":
      return (
        <text className="aiko-pop" x="124" y="48" fontSize="30" fontWeight="800" fill={C.bookDeep} fontFamily="var(--font-rounded), system-ui">
          ?
        </text>
      );
    case "celebrating":
      return (
        <g>
          <Sparkle x={22} y={46} s={1.2} />
          <Sparkle x={140} y={40} s={1.4} delay={0.3} />
          <Sparkle x={150} y={86} s={0.8} delay={0.7} />
          <circle className="aiko-pop" cx="14" cy="88" r="3.2" fill="#f4907c" />
          <circle className="aiko-pop" style={{ animationDelay: ".4s" }} cx="148" cy="62" r="3" fill={C.book} />
          <rect className="aiko-pop" style={{ animationDelay: ".8s" }} x="26" y="22" width="7" height="3.6" rx="1.8" fill={C.leaf} transform="rotate(-30 29 24)" />
        </g>
      );
    case "encouraging":
      return (
        <path
          className="aiko-pop"
          transform="translate(139 66)"
          d="M0 4 C-9 -4 -7 -12 0 -8 C7 -12 9 -4 0 4Z"
          fill="#f4907c"
          stroke="#d9695a"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      );
    case "curious":
      return <Sparkle x={134} y={58} s={0.9} />;
    default:
      return null;
  }
}

export function Aiko({
  mood = "happy",
  motion,
  size = 120,
  label,
  className = "",
}: {
  mood?: Mood;
  /** override the mood's default animation; "none" holds still */
  motion?: Motion;
  /** rendered height in px (width follows) */
  size?: number;
  /** spoken name for screen readers; omitted means decorative */
  label?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const m = motion ?? DEFAULT_MOTION[mood];
  const sleepy = mood === "sleeping";
  return (
    <svg
      viewBox="0 0 160 170"
      width={(size * 160) / 170}
      height={size}
      className={`aiko ${MOTION_CLASS[m]} ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-mood={mood}
    >
      <defs>
        <pattern id={`h${uid}`} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 4.5H9M4.5 0V9" stroke={C.capHatch} strokeWidth="1.1" opacity=".5" />
        </pattern>
      </defs>
      <ellipse className="aiko-shadow" cx="80" cy="159" rx="34" ry="5.5" fill="#5c4630" opacity=".16" />
      {/* feet */}
      <ellipse cx="64" cy="152" rx="12" ry="7" fill={C.bodyDeep} />
      <ellipse cx="96" cy="152" rx="12" ry="7" fill={C.bodyDeep} />
      {/* body */}
      <path d="M38 94 C38 62 58 50 80 50 C102 50 122 62 122 94 C122 126 104 152 80 152 C56 152 38 126 38 94Z" fill={C.body} />
      <ellipse cx="80" cy="124" rx="24" ry="22" fill={C.belly} />
      <path d="M46 112 C46 124 52 138 62 146" stroke={C.bodyDeep} strokeWidth="2" strokeLinecap="round" fill="none" opacity=".45" />
      <Arms mood={mood} />
      {/* cap */}
      <path d="M30 74 C27 42 52 24 80 24 C108 24 133 42 130 74 C120 82 40 82 30 74Z" fill={C.cap} />
      <path d="M30 74 C27 42 52 24 80 24 C108 24 133 42 130 74 C120 82 40 82 30 74Z" fill={`url(#h${uid})`} />
      <path d="M28 68 C28 62 36 60 80 60 C124 60 132 62 132 68 C132 79 124 84 80 84 C36 84 28 79 28 68Z" fill={C.capDeep} />
      <path d="M44 38 C52 31 62 28 70 28" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" opacity=".35" />
      {/* stem and leaf */}
      <path d="M80 25 C80 16 83 11 88 8" stroke={C.stem} strokeWidth="5" strokeLinecap="round" fill="none" />
      <path d="M88 9 C95 -1 112 1 114 9 C106 17 93 16 88 9Z" fill={C.leaf} stroke="#7fb04a" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M92 9 C98 6 104 6 110 8" stroke="#7fb04a" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      {/* face */}
      <ellipse cx="53" cy="112" rx="8" ry="5" fill={C.cheek} opacity={sleepy ? 0.45 : 0.6} />
      <ellipse cx="107" cy="112" rx="8" ry="5" fill={C.cheek} opacity={sleepy ? 0.45 : 0.6} />
      <Brows mood={mood} />
      <Eyes mood={mood} />
      <Mouth mood={mood} />
      <Props mood={mood} />
    </svg>
  );
}

/** Aiko with something to say: a speech bubble beside (or above) the character. Use sparingly. */
export function AikoSays({
  mood = "happy",
  motion,
  size = 96,
  title,
  children,
  className = "",
}: {
  mood?: Mood;
  motion?: Motion;
  size?: number;
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start gap-3 ${className}`}>
      <Aiko mood={mood} motion={motion} size={size} className="shrink-0" />
      <div className="bubble bubble-left mt-3 min-w-0 flex-1 rounded-2xl px-4 py-3">
        {title && <p className="font-display text-lg leading-snug">{title}</p>}
        {children && <div className={`text-[15px] text-ink-soft ${title ? "mt-1" : ""}`}>{children}</div>}
      </div>
    </div>
  );
}
