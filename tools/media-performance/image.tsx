import type { ImgHTMLAttributes } from "react";
/** Harness adapter: the gallery uses unoptimized Next images in production. */
export default function Image({
  unoptimized: _u,
  fill: _f,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  unoptimized?: boolean;
  fill?: boolean;
}) {
  return <img {...props} />;
}
