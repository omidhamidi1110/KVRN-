// next/image custom loader (images.loaderFile in next.config.js). Runs in the browser and on the server; keep it dependency-free.
import { loadImage } from './responsive-image'

export default function kvrnImageLoader({ src, width }: { src: string; width: number; quality?: number }): string {
  return loadImage(src, width)
}
