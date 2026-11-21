import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Item, Person } from "../../../core/diagram/model.ts";
import ObjectThumbnail from "./ObjectThumbnail.tsx";

export type PaletteObject = { kind: Item["kind"] } | { sex: Person["sex"] };
export default function usePaletteDrag(
  onDrop: (object: PaletteObject, point: { x: number; y: number }) => void,
) {
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    object: PaletteObject;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [ghost, setGhost] = useState<{
    object: PaletteObject;
    x: number;
    y: number;
  } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  function clear(e: ReactPointerEvent<HTMLButtonElement>) {
    gesture.current = null;
    setGhost(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function bind(object: PaletteObject, activate: () => void) {
    return {
      onDragStart: (e: React.DragEvent) => e.preventDefault(),
      onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (!e.isPrimary || e.button !== 0) return;
        suppressClick.current = false;
        gesture.current = {
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          object,
          moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
        const g = gesture.current;
        if (!g || g.pointerId !== e.pointerId) return;
        if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) >= 8) {
          g.moved = true;
          setGhost({ object: g.object, x: e.clientX, y: e.clientY });
        }
        // Move only the small ghost, without rerendering the diagram on every event.
        if (g.moved && element.current)
          element.current.style.transform = `translate(${e.clientX + 12}px,${e.clientY + 12}px)`;
      },
      onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
        const g = gesture.current;
        if (!g || g.pointerId !== e.pointerId) return;
        if (g.moved) {
          suppressClick.current = true;
          e.preventDefault();
          onDrop(g.object, { x: e.clientX, y: e.clientY });
        }
        clear(e);
      },
      onPointerCancel: (e: ReactPointerEvent<HTMLButtonElement>) => {
        suppressClick.current = false;
        clear(e);
      },
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        if (suppressClick.current && e.detail !== 0) {
          suppressClick.current = false;
          return;
        }
        suppressClick.current = false;
        activate();
      },
    };
  }
  return {
    bind,
    isDragging: !!ghost,
    preview: ghost && (
      <div
        ref={element}
        className="palette-drag-preview"
        aria-hidden="true"
        style={{ transform: `translate(${ghost.x + 12}px,${ghost.y + 12}px)` }}
      >
        {"kind" in ghost.object ? (
          <ObjectThumbnail kind={ghost.object.kind} />
        ) : (
          <ObjectThumbnail sex={ghost.object.sex} />
        )}
      </div>
    ),
  };
}
