// 待機動作と瞬き頻度へ連続的な揺らぎを与える2次元Perlinノイズです。
// Joseph GentleのnoisejsをTypeScript向けに整理した実装です。
// noisejsはStefan Gustavsonによるpublic domain実装を基にしており、ISCライセンスで提供されています。
// Copyright (c) 2013, Joseph Gentle. 詳細はthird_party_licenses/noisejs-ISC.txtを参照してください。
class Gradient {
  constructor(public readonly x: number, public readonly y: number) {}

  /** 格子点からの距離との内積を求め、滑らかな勾配ノイズを作ります。 */
  dot(x: number, y: number): number {
    return this.x * x + this.y * y
  }
}

const gradients = [
  new Gradient(1, 1), new Gradient(-1, 1), new Gradient(1, -1), new Gradient(-1, -1),
  new Gradient(1, 0), new Gradient(-1, 0), new Gradient(0, 1), new Gradient(0, -1),
]

const permutation = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140,
  36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234,
  75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237,
  149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48,
  27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105,
  92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73,
  209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86,
  164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38,
  147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189,
  28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101,
  155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
  178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12,
  191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31,
  181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254,
  138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215,
  61, 156, 180,
]

const fade = (value: number) => value ** 3 * (value * (value * 6 - 15) + 10)
const lerp = (from: number, to: number, weight: number) => (1 - weight) * from + weight * to

export class PerlinNoise2D {
  private readonly perm = new Array<number>(512)
  private readonly gradientPerm = new Array<Gradient>(512)

  constructor(seed: number) {
    this.seed(seed)
  }

  /** キャラクターごとに再現可能で異なるノイズ系列を初期化します。 */
  private seed(seed: number): void {
    let normalized = seed
    if (normalized > 0 && normalized < 1) normalized *= 65536
    normalized = Math.floor(normalized)
    if (normalized < 256) normalized |= normalized << 8
    for (let index = 0; index < 256; index += 1) {
      const value = index & 1
        ? permutation[index] ^ (normalized & 255)
        : permutation[index] ^ ((normalized >> 8) & 255)
      this.perm[index] = this.perm[index + 256] = value
      this.gradientPerm[index] = this.gradientPerm[index + 256] = gradients[value % gradients.length]
    }
  }

  /** 任意の座標から連続した-1～1付近のノイズ値を取得します。 */
  perlin2(x: number, y: number): number {
    let cellX = Math.floor(x)
    let cellY = Math.floor(y)
    const localX = x - cellX
    const localY = y - cellY
    cellX &= 255
    cellY &= 255
    const n00 = this.gradientPerm[cellX + this.perm[cellY]].dot(localX, localY)
    const n01 = this.gradientPerm[cellX + this.perm[cellY + 1]].dot(localX, localY - 1)
    const n10 = this.gradientPerm[cellX + 1 + this.perm[cellY]].dot(localX - 1, localY)
    const n11 = this.gradientPerm[cellX + 1 + this.perm[cellY + 1]].dot(localX - 1, localY - 1)
    return lerp(lerp(n00, n10, fade(localX)), lerp(n01, n11, fade(localX)), fade(localY))
  }
}
