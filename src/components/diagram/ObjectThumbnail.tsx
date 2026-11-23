import { colors, type Item, type Person } from "../../../core/diagram/model.ts";
import { houseShape } from "../../../core/diagram/house-shapes.ts";
import { mark } from "./captions.ts";

// Lightweight SVGs mirror the shapes used on the editing canvas.
export default function ObjectThumbnail({
  kind,
  body,
  house,
  sex,
}: {
  kind?: Item["kind"];
  body?: boolean;
  house?: boolean;
  sex?: Person["sex"];
}) {
  if (house && kind) {
    const [width, height] = kind === "wall" || kind === "rail" ? [68, 36]
      : kind === "room" ? [64, 44]
      : kind === "bed" || kind === "wheelchair" ? [38, 46]
      : kind === "toilet" ? [32, 46]
      : kind === "bathtub" ? [66, 42]
      : [44, 40];
    const y = kind === "wall" || kind === "rail" ? 29 : (58 - height) / 2;
    return (
      <svg viewBox="0 0 100 58" aria-hidden="true" focusable="false">
        <g transform={`translate(${(100 - width) / 2},${y})`}
          dangerouslySetInnerHTML={{ __html: houseShape({ kind, width, height, wallLine: kind === "wall" ? true : undefined, railLine: kind === "rail" ? true : undefined }) }} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 100 58" aria-hidden="true" focusable="false">
      {sex ? (
        <g fill="white" stroke="#172b3d" strokeWidth="3">
          {sex === "female" ? (
            <circle cx="50" cy="29" r="23" />
          ) : sex === "male" ? (
            <rect x="27" y="6" width="46" height="46" />
          ) : (
            <path d="M50 4 75 29 50 54 25 29Z" />
          )}
        </g>
      ) : body && kind ? (
        <text
          x="50"
          y="43"
          textAnchor="middle"
          fontSize={kind === "note" ? "25" : "46"}
          fill="#111"
        >
          {kind === "note" ? "メモ" : mark(kind)}
        </text>
      ) : kind === "step" ? (
        <polygon points="50,8 76,50 24,50" fill="#25394a" />
      ) : kind ? (
        <g stroke="#6e8b80" strokeWidth="2">
          <rect
            x={kind === "bed" ? 35 : 8}
            y={kind === "wall" ? 23 : kind === "rail" ? 17 : 5}
            width={kind === "bed" ? 30 : 84}
            height={kind === "wall" ? 9 : kind === "rail" ? 25 : 48}
            fill={colors[kind]}
            opacity={kind === "room" ? 0.5 : 0.9}
            rx={kind === "room" ? 0 : 3}
          />
          {kind === "bed" && (
            <rect x="38" y="9" width="24" height="10" fill="white" rx="2" />
          )}
          {kind === "rail" && (
            <path
              d="M15 29H85"
              stroke="#165b50"
              strokeWidth="5"
              strokeLinecap="round"
            />
          )}
        </g>
      ) : null}
    </svg>
  );
}
