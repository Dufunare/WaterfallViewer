import { ImageSource, Texture } from "pixi.js";

import type { AssetLeaseBackend } from "./assetLeasePool";

export class PixiImageTextureBackend implements AssetLeaseBackend<Texture> {
  async load(uri: string): Promise<Texture> {
    const image = await loadImage(uri);
    const source = new ImageSource({ resource: image });
    source.scaleMode = "linear";
    return new Texture({ source });
  }

  unload(_uri: string, texture: Texture): void {
    texture.destroy(true);
  }
}

async function loadImage(uri: string): Promise<HTMLImageElement> {
  if (uri.trim().length === 0) {
    throw new RangeError("image uri must not be empty");
  }

  const image = new Image();
  image.decoding = "async";

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`failed to load image texture: ${uri}`));
    image.src = uri;
  });

  return image;
}
