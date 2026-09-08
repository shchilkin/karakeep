import { createContext } from "react";

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
