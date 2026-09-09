import { createContext } from "react";

export interface ImageDimensions {
  width?: number | null;
  height?: number | null;
}

export function validImageDimensions(value?: ImageDimensions) {
  const { width, height } = value ?? {};
  return typeof width === "number" &&
    typeof height === "number" &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : undefined;
}

export interface CardImageDimensions {
  src: string;
  width: number;
  height: number;
}

/** The feed owns this slot so unmounting a card does not forget its proportions. */
export interface CardImageDimensionsSlot {
  current?: CardImageDimensions;
}

export const CardImageDimensionsContext =
  createContext<CardImageDimensionsSlot | null>(null);
