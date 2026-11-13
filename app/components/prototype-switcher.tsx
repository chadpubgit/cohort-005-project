// PROTOTYPE: throwaway floating variant switcher for UI prototypes.
// Lives on the `notif-proto` branch only; never merge to main.
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface PrototypeVariant {
  key: string;
  name: string;
}

const STORAGE_KEY = "prototype-variant";

/**
 * Reads `?variant=` from the URL. Normal app links drop the search param, so
 * the last choice is kept in sessionStorage and put back on the URL after each
 * navigation, so the variant survives clicking around the app.
 */
export function usePrototypeVariant(variants: PrototypeVariant[]): string {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("variant");
  const valid = variants.some((v) => v.key === fromUrl);

  useEffect(() => {
    if (fromUrl && valid) {
      sessionStorage.setItem(STORAGE_KEY, fromUrl);
      return;
    }
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored && variants.some((v) => v.key === stored)) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("variant", stored);
          return next;
        },
        { replace: true, preventScrollReset: true }
      );
    }
  }, [fromUrl, valid, variants, setParams]);

  return valid && fromUrl ? fromUrl : variants[0].key;
}

export function PrototypeSwitcher({
  variants,
  current,
  children,
}: {
  variants: PrototypeVariant[];
  current: string;
  /** Extra state readout / toggles rendered in the bar. */
  children?: React.ReactNode;
}) {
  const [, setParams] = useSearchParams();
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current)
  );

  function go(delta: number) {
    const next = variants[(index + delta + variants.length) % variants.length];
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("variant", next.key);
        return p;
      },
      { replace: true, preventScrollReset: true }
    );
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;

  const v = variants[index];
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full bg-fuchsia-700 px-2 py-1.5 text-sm text-white shadow-2xl ring-2 ring-fuchsia-300">
      <button
        onClick={() => go(-1)}
        className="rounded-full p-1 hover:bg-white/20"
        title="Previous variant (←)"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="font-semibold whitespace-nowrap">
        {v.key} ({v.name})
      </span>
      <button
        onClick={() => go(1)}
        className="rounded-full p-1 hover:bg-white/20"
        title="Next variant (→)"
      >
        <ChevronRight className="size-4" />
      </button>
      {children && (
        <div className="flex items-center gap-2 border-l border-white/30 pl-3 pr-2 text-xs whitespace-nowrap">
          {children}
        </div>
      )}
    </div>
  );
}
