/*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
// https://www.secg.org/sec2-v2.pdf

// Uses built-in crypto module from node.js to generate randomness / hmac-sha256.
// In browser the line is automatically removed during build time: uses crypto.subtle instead.
import nodeCrypto from 'crypto'

const pow = (a: bigint, b: bigint) => {
  let result = 1n
  for (let i = 0, e = b; i < e; i++) {
    result *= a
  }
  return result
}

// Be friendly to bad ECMAScript parsers by not using bigint literals like 123n
const _0n = BigInt(0)
const _1n = BigInt(1)
const _2n = BigInt(2)
const _3n = BigInt(3)
const _8n = BigInt(8)

// Curve fomula is y² = x³ + ax + b
const POW_2_256 = pow(_2n, BigInt(256))
const CURVE = {
  // Params: a, b
  a: _0n,
  b: BigInt(7),
  // Field over which we'll do calculations
  P: POW_2_256 - pow(_2n, BigInt(32)) - BigInt(977),
  // Curve order, a number of valid points in the field
  n: POW_2_256 - BigInt('432420386565659656852420866394968145599'),
  // Cofactor. It's 1, so other subgroups don't exist, and default subgroup is prime-order
  h: _1n,
  // Base point (x, y) aka generator point
  Gx: BigInt(
    '55066263022277343669578718895168534326250603453777594175500187360389116729240'
  ),
  Gy: BigInt(
    '32670510020758816978083085130507043184471273380659243275938904335757337482424'
  ),
  // For endomorphism, see below
  beta: BigInt(
    '0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee'
  ),
}

// Cleaner js output if that's on a separate line.
export { CURVE }

/**
 * y² = x³ + ax + b: Short weistrass curve formula
 *
 * @returns y²
 */
function weistrass(x: bigint): bigint {
  const { a, b } = CURVE
  const x2 = mod(x * x)
  const x3 = mod(x2 * x)
  return mod(x3 + a * x + b)
}

// We accept hex strings besides Uint8Array for simplicity
type Hex = Uint8Array | string
// Very few implementations accept numbers, we do it to ease learning curve
type PrivKey = Hex | bigint | number
// 33/65-byte ECDSA key, or 32-byte Schnorr key - not interchangeable
type PubKey = Hex | Point
// ECDSA signature
type Sig = Hex | Signature

/**
 * Always true for secp256k1.
 * We're including it here if you'll want to reuse code to support
 * different curve (e.g. secp256r1) - just set it to false then.
 * Endomorphism only works for Koblitz curves with a == 0.
 * It improves efficiency:
 * Uses 2x less RAM, speeds up precomputation by 2x and ECDH / sign key recovery by 20%.
 * Should always be used for Jacobian's double-and-add multiplication.
 * For affines cached multiplication, it trades off 1/2 init time & 1/3 ram for 20% perf hit.
 * https://gist.github.com/paulmillr/eb670806793e84df628a7c434a873066
 */
const USE_ENDOMORPHISM = CURVE.a === _0n

/**
 * Jacobian Point works in 3d / jacobi coordinates: (x, y, z) ∋ (x=x/z², y=y/z³)
 * Default Point works in 2d / affine coordinates: (x, y)
 * We're doing calculations in jacobi, because its operations don't require costly inversion.
 */
class JacobianPoint {
  constructor(readonly x: bigint, readonly y: bigint, readonly z: bigint) {}

  static readonly BASE = new JacobianPoint(CURVE.Gx, CURVE.Gy, _1n)
  static readonly ZERO = new JacobianPoint(_0n, _1n, _0n)
  static fromAffine(p: Point): JacobianPoint {
    if (!(p instanceof Point)) {
      throw new TypeError('JacobianPoint#fromAffine: expected Point')
    }
    return new JacobianPoint(p.x, p.y, _1n)
  }

  /**
   * Takes a bunch of Jacobian Points but executes only one
   * invert on all of them. invert is very slow operation,
   * so this improves performance massively.
   */
  static toAffineBatch(points: JacobianPoint[]): Point[] {
    const toInv = invertBatch(points.map((p) => p.z))
    return points.map((p, i) => p.toAffine(toInv[i]))
  }

  static normalizeZ(points: JacobianPoint[]): JacobianPoint[] {
    return JacobianPoint.toAffineBatch(points).map(JacobianPoint.fromAffine)
  }

  /**
   * Compare one point to another.
   */
  equals(other: JacobianPoint): boolean {
    const a = this
    const b = other
    const az2 = mod(a.z * a.z)
    const az3 = mod(a.z * az2)
    const bz2 = mod(b.z * b.z)
    const bz3 = mod(b.z * bz2)
    return (
      mod(a.x * bz2) === mod(az2 * b.x) && mod(a.y * bz3) === mod(az3 * b.y)
    )
  }

  /**
   * Flips point to one corresponding to (x, -y) in Affine coordinates.
   */
  negate(): JacobianPoint {
    return new JacobianPoint(this.x, mod(-this.y), this.z)
  }

  // Fast algo for doubling 2 Jacobian Points when curve's a=0.
  // Note: cannot be reused for other curves when a != 0.
  // From: http://hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html#doubling-dbl-2009-l
  // Cost: 2M + 5S + 6add + 3*2 + 1*3 + 1*8.
  double(): JacobianPoint {
    const X1 = this.x
    const Y1 = this.y
    const Z1 = this.z
    const A = mod(pow(X1, _2n))
    const B = mod(pow(Y1, _2n))
    const C = mod(pow(B, _2n))
    const D = mod(_2n * (mod(mod(pow(X1 + B, _2n))) - A - C))
    const E = mod(_3n * A)
    const F = mod(pow(E, _2n))
    const X3 = mod(F - _2n * D)
    const Y3 = mod(E * (D - X3) - _8n * C)
    const Z3 = mod(_2n * Y1 * Z1)
    return new JacobianPoint(X3, Y3, Z3)
  }

  // Fast algo for adding 2 Jacobian Points when curve's a=0.
  // Note: cannot be reused for other curves when a != 0.
  // http://hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html#addition-add-1998-cmo-2
  // Cost: 12M + 4S + 6add + 1*2.
  // Note: 2007 Bernstein-Lange (11M + 5S + 9add + 4*2) is actually *slower*. No idea why.
  add(other: JacobianPoint): JacobianPoint {
    if (!(other instanceof JacobianPoint)) {
      throw new TypeError('JacobianPoint#add: expected JacobianPoint')
    }
    const X1 = this.x
    const Y1 = this.y
    const Z1 = this.z
    const X2 = other.x
    const Y2 = other.y
    const Z2 = other.z
    if (X2 === _0n || Y2 === _0n) return this
    if (X1 === _0n || Y1 === _0n) return other
    const Z1Z1 = mod(pow(Z1, _2n))
    const Z2Z2 = mod(pow(Z2, _2n))
    const U1 = mod(X1 * Z2Z2)
    const U2 = mod(X2 * Z1Z1)
    const S1 = mod(Y1 * Z2 * Z2Z2)
    const S2 = mod(mod(Y2 * Z1) * Z1Z1)
    const H = mod(U2 - U1)
    const r = mod(S2 - S1)
    // H = 0 meaning it's the same point.
    if (H === _0n) {
      if (r === _0n) {
        return this.double()
      } else {
        return JacobianPoint.ZERO
      }
    }
    const HH = mod(pow(H, _2n))
    const HHH = mod(H * HH)
    const V = mod(U1 * HH)
    const X3 = mod(pow(r, _2n) - HHH - _2n * V)
    const Y3 = mod(r * (V - X3) - S1 * HHH)
    const Z3 = mod(Z1 * Z2 * H)
    return new JacobianPoint(X3, Y3, Z3)
  }

  subtract(other: JacobianPoint) {
    return this.add(other.negate())
  }

  /**
   * Non-constant-time multiplication. Uses double-and-add algorithm.
   * It's faster, but should only be used when you don't care about
   * an exposed private key e.g. sig verification, which works over *public* keys.
   */
  multiplyUnsafe(scalar: bigint): JacobianPoint {
    let n = normalizeScalar(scalar)
    // The condition is not executed unless you change global var
    if (!USE_ENDOMORPHISM) {
      let p = JacobianPoint.ZERO
      let d: JacobianPoint = this
      while (n > _0n) {
        if (n & _1n) p = p.add(d)
        d = d.double()
        n >>= _1n
      }
      return p
    }
    let { k1neg, k1, k2neg, k2 } = splitScalarEndo(n)
    let k1p = JacobianPoint.ZERO
    let k2p = JacobianPoint.ZERO
    let d: JacobianPoint = this
    while (k1 > _0n || k2 > _0n) {
      if (k1 & _1n) k1p = k1p.add(d)
      if (k2 & _1n) k2p = k2p.add(d)
      d = d.double()
      k1 >>= _1n
      k2 >>= _1n
    }
    if (k1neg) k1p = k1p.negate()
    if (k2neg) k2p = k2p.negate()
    k2p = new JacobianPoint(mod(k2p.x * CURVE.beta), k2p.y, k2p.z)
    return k1p.add(k2p)
  }

  /**
   * Creates a wNAF precomputation window. Used for caching.
   * Default window size is set by `utils.precompute()` and is equal to 8.
   * Which means we are caching 65536 points: 256 points for every bit from 0 to 256.
   *
   * @returns 65K precomputed points, depending on W
   */
  private precomputeWindow(W: number): JacobianPoint[] {
    // splitScalarEndo could return 129-bit numbers, so we need at least 128 / W + 1
    const windows = USE_ENDOMORPHISM ? 128 / W + 1 : 256 / W + 1
    const points: JacobianPoint[] = []
    let p: JacobianPoint = this
    let base = p
    for (let window = 0; window < windows; window++) {
      base = p
      points.push(base)
      for (let i = 1; i < 2 ** (W - 1); i++) {
        base = base.add(p)
        points.push(base)
      }
      p = base.double()
    }
    return points
  }

  /**
   * Implements w-ary non-adjacent form for calculating ec multiplication.
   *
   * @param n
   * @param affinePoint optional 2d point to save cached precompute windows on it.
   * @returns real and fake (for const-time) points
   */
  private wNAF(
    n: bigint,
    affinePoint?: Point
  ): { p: JacobianPoint; f: JacobianPoint } {
    if (!affinePoint && this.equals(JacobianPoint.BASE))
      affinePoint = Point.BASE
    const W = (affinePoint && affinePoint._WINDOW_SIZE) || 1
    if (256 % W) {
      throw new Error(
        'Point#wNAF: Invalid precomputation window, must be power of 2'
      )
    }

    // Calculate precomputes on a first run, reuse them after
    let precomputes = affinePoint && pointPrecomputes.get(affinePoint)
    if (!precomputes) {
      precomputes = this.precomputeWindow(W)
      if (affinePoint && W !== 1) {
        precomputes = JacobianPoint.normalizeZ(precomputes)
        pointPrecomputes.set(affinePoint, precomputes)
      }
    }

    // Initialize real and fake points for const-time
    let p = JacobianPoint.ZERO
    let f = JacobianPoint.ZERO

    const windows = USE_ENDOMORPHISM ? 128 / W + 1 : 256 / W + 1
    const windowSize = 2 ** (W - 1) // W=8 128
    const mask = BigInt(2 ** W - 1) // Create mask with W ones: 0b11111111 for W=8
    const maxNumber = 2 ** W // W=8 256
    const shiftBy = BigInt(W) // W=8 8

    // TODO: review this more carefully
    for (let window = 0; window < windows; window++) {
      const offset = window * windowSize
      // Extract W bits.
      let wbits = Number(n & mask)

      // Shift number by W bits.
      n >>= shiftBy

      // If the bits are bigger than max size, we'll split those.
      // +224 => 256 - 32
      if (wbits > windowSize) {
        wbits -= maxNumber
        n += _1n
      }

      // Check if we're onto Zero point.
      // Add random point inside current window to f.
      if (wbits === 0) {
        // The most important part for const-time getPublicKey
        let pr = precomputes[offset]
        if (window % 2) pr = pr.negate()
        f = f.add(pr)
      } else {
        let cached = precomputes[offset + Math.abs(wbits) - 1]
        if (wbits < 0) cached = cached.negate()
        p = p.add(cached)
      }
    }
    return { p, f }
  }

  /**
   * Constant time multiplication.
   * Uses wNAF method. Windowed method may be 10% faster,
   * but takes 2x longer to generate and consumes 2x memory.
   *
   * @param scalar by which the point would be multiplied
   * @param affinePoint optional point ot save cached precompute windows on it
   * @returns New point
   */
  multiply(scalar: number | bigint, affinePoint?: Point): JacobianPoint {
    const n = normalizeScalar(scalar)
    // Real point.
    let point: JacobianPoint
    // Fake point, we use it to achieve constant-time multiplication.
    let fake: JacobianPoint
    if (USE_ENDOMORPHISM) {
      const { k1neg, k1, k2neg, k2 } = splitScalarEndo(n)
      let { p: k1p, f: f1p } = this.wNAF(k1, affinePoint)
      let { p: k2p, f: f2p } = this.wNAF(k2, affinePoint)
      if (k1neg) k1p = k1p.negate()
      if (k2neg) k2p = k2p.negate()
      k2p = new JacobianPoint(mod(k2p.x * CURVE.beta), k2p.y, k2p.z)
      point = k1p.add(k2p)
      fake = f1p.add(f2p)
    } else {
      const { p, f } = this.wNAF(n, affinePoint)
      point = p
      fake = f
    }
    // Normalize `z` for both points, but return only real one
    return JacobianPoint.normalizeZ([point, fake])[0]
  }

  // Converts Jacobian point to affine (x, y) coordinates.
  // Can accept precomputed Z^-1 - for example, from invertBatch.
  // (x, y, z) ∋ (x=x/z², y=y/z³)
  toAffine(invZ: bigint = invert(this.z)): Point {
    const invZ2 = pow(invZ, _2n)
    const x = mod(this.x * invZ2)
    const y = mod(this.y * invZ2 * invZ)
    return new Point(x, y)
  }
}

// Stores precomputed values for points.
const pointPrecomputes = new WeakMap<Point, JacobianPoint[]>()

/**
 * Default Point works in default aka affine coordinates: (x, y)
 */
export class Point {
  /**
   * Base point aka generator. public_key = Point.BASE * private_key
   */
  static BASE: Point = new Point(CURVE.Gx, CURVE.Gy)
  /**
   * Identity point aka point at infinity. point = point + zero_point
   */
  static ZERO: Point = new Point(_0n, _0n)
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  _WINDOW_SIZE?: number

  constructor(readonly x: bigint, readonly y: bigint) {}

  // "Private method", don't use it directly
  _setWindowSize(windowSize: number) {
    this._WINDOW_SIZE = windowSize
    pointPrecomputes.delete(this)
  }

  /**
   * Supports compressed Schnorr (32-byte) and ECDSA (33-byte) points
   *
   * @param bytes 32/33 bytes
   * @returns Point instance
   */
  private static fromCompressedHex(bytes: Uint8Array) {
    const isShort = bytes.length === 32
    const x = bytesToNumber(isShort ? bytes : bytes.slice(1))
    if (!isValidFieldElement(x)) throw new Error('Point is not on curve')
    const y2 = weistrass(x) // y² = x³ + ax + b
    let y = sqrtMod(y2) // y = y² ^ (p+1)/4
    const isYOdd = (y & _1n) === _1n
    if (isShort) {
      // Schnorr
      if (isYOdd) y = mod(-y)
    } else {
      // ECDSA
      const isFirstByteOdd = (bytes[0] & 1) === 1
      if (isFirstByteOdd !== isYOdd) y = mod(-y)
    }
    const point = new Point(x, y)
    point.assertValidity()
    return point
  }

  // Schnorr doesn't support uncompressed points, so this is only for ECDSA
  private static fromUncompressedHex(bytes: Uint8Array) {
    const x = bytesToNumber(bytes.slice(1, 33))
    const y = bytesToNumber(bytes.slice(33))
    const point = new Point(x, y)
    point.assertValidity()
    return point
  }

  /**
   * Converts hash string or Uint8Array to Point.
   *
   * @param hex 32-byte (schnorr) or 33/65-byte (ECDSA) hex
   */
  static fromHex(hex: Hex): Point {
    const bytes = ensureBytes(hex)
    const header = bytes[0]
    if (
      bytes.length === 32 ||
      (bytes.length === 33 && (header === 0x02 || header === 0x03))
    ) {
      return this.fromCompressedHex(bytes)
    }
    if (bytes.length === 65 && header === 0x04)
      return this.fromUncompressedHex(bytes)
    throw new Error(
      `Point.fromHex: received invalid point. Expected 32-33 compressed bytes or 65 uncompressed bytes, not ${bytes.length}`
    )
  }

  // Multiplies generator point by privateKey.
  static fromPrivateKey(privateKey: PrivKey) {
    return Point.BASE.multiply(normalizePrivateKey(privateKey))
  }

  /**
   * Recovers public key from ECDSA signature.
   * https://crypto.stackexchange.com/questions/60218
   * ```
   * Q = (1 / r)(sP - hG)
   * ```
   */
  static fromSignature(msgHash: Hex, signature: Sig, recovery: number): Point {
    msgHash = ensureBytes(msgHash)
    const h = truncateHash(msgHash)
    const { r, s } = normalizeSignature(signature)
    if (recovery !== 0 && recovery !== 1) {
      throw new Error('Cannot recover signature: invalid recovery bit')
    }
    if (h === _0n)
      throw new Error('Cannot recover signature: msgHash cannot be 0')
    const prefix = 2 + (recovery & 1)
    const P_ = Point.fromHex(`0${prefix}${numTo32bStr(r)}`)
    const sP = JacobianPoint.fromAffine(P_).multiplyUnsafe(s)
    const hG = JacobianPoint.BASE.multiply(h)
    const rinv = invert(r, CURVE.n)
    const Q = sP.subtract(hG).multiplyUnsafe(rinv)
    const point = Q.toAffine()
    point.assertValidity()
    return point
  }

  toRawBytes(isCompressed = false): Uint8Array {
    return hexToBytes(this.toHex(isCompressed))
  }

  toHex(isCompressed = false): string {
    const x = numTo32bStr(this.x)
    if (isCompressed) {
      return `${this.y & _1n ? '03' : '02'}${x}`
    } else {
      return `04${x}${numTo32bStr(this.y)}`
    }
  }

  // Schnorr-related function
  toHexX() {
    return this.toHex(true).slice(2)
  }

  toRawX() {
    return this.toRawBytes(true).slice(1)
  }

  // A point on curve is valid if it conforms to equation.
  assertValidity(): void {
    const msg = 'Point is not on elliptic curve'
    const { x, y } = this
    if (!isValidFieldElement(x) || !isValidFieldElement(y)) throw new Error(msg)
    const left = mod(y * y)
    const right = weistrass(x)
    if (mod(left - right) !== _0n) throw new Error(msg)
  }

  equals(other: Point): boolean {
    return this.x === other.x && this.y === other.y
  }

  // Returns the same point with inverted `y`
  negate() {
    return new Point(this.x, mod(-this.y))
  }

  // Adds point to itself
  double() {
    return JacobianPoint.fromAffine(this).double().toAffine()
  }

  // Adds point to other point
  add(other: Point) {
    return JacobianPoint.fromAffine(this)
      .add(JacobianPoint.fromAffine(other))
      .toAffine()
  }

  // Subtracts other point from the point
  subtract(other: Point) {
    return this.add(other.negate())
  }

  multiply(scalar: number | bigint) {
    return JacobianPoint.fromAffine(this).multiply(scalar, this).toAffine()
  }
}

function sliceDER(s: string): string {
  // Proof: any([(i>=0x80) == (int(hex(i).replace('0x', '').zfill(2)[0], 16)>=8)  for i in range(0, 256)])
  // Padding done by numberToHex
  return Number.parseInt(s[0], 16) >= 8 ? '00' + s : s
}

function parseDERInt(data: Uint8Array) {
  if (data.length < 2 || data[0] !== 0x02) {
    throw new Error(`Invalid signature integer tag: ${bytesToHex(data)}`)
  }
  const len = data[1]
  const res = data.subarray(2, len + 2)
  if (!len || res.length !== len) {
    throw new Error(`Invalid signature integer: wrong length`)
  }
  // Strange condition, its not about length, but about first bytes of number.
  if (res[0] === 0x00 && res[1] <= 0x7f) {
    throw new Error('Invalid signature integer: trailing length')
  }
  return { data: bytesToNumber(res), left: data.subarray(len + 2) }
}

function parseDERSignature(data: Uint8Array) {
  if (data.length < 2 || data[0] !== 0x30) {
    throw new Error(`Invalid signature tag: ${bytesToHex(data)}`)
  }
  if (data[1] !== data.length - 2) {
    throw new Error('Invalid signature: incorrect length')
  }
  const { data: r, left: sBytes } = parseDERInt(data.subarray(2))
  const { data: s, left: rBytesLeft } = parseDERInt(sBytes)
  if (rBytesLeft.length) {
    throw new Error(
      `Invalid signature: left bytes after parsing: ${bytesToHex(rBytesLeft)}`
    )
  }
  return { r, s }
}

// Represents ECDSA signature with its (r, s) properties
export class Signature {
  constructor(readonly r: bigint, readonly s: bigint) {
    this.assertValidity()
  }

  // pair (32 bytes of r, 32 bytes of s)
  static fromCompact(hex: Hex) {
    const arr = isUint8a(hex)
    const name = 'Signature.fromCompact'
    if (typeof hex !== 'string' && !arr)
      throw new TypeError(`${name}: Expected string or Uint8Array`)
    const str = arr ? bytesToHex(hex) : hex
    if (str.length !== 128) throw new Error(`${name}: Expected 64-byte hex`)
    return new Signature(
      hexToNumber(str.slice(0, 64)),
      hexToNumber(str.slice(64, 128))
    )
  }

  // DER encoded ECDSA signature
  // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
  static fromDER(hex: Hex) {
    const arr = isUint8a(hex)
    if (typeof hex !== 'string' && !arr)
      throw new TypeError(`Signature.fromDER: Expected string or Uint8Array`)
    const { r, s } = parseDERSignature(arr ? hex : hexToBytes(hex))
    return new Signature(r, s)
  }

  // Don't use this method
  static fromHex(hex: Hex) {
    return this.fromDER(hex)
  }

  assertValidity(): void {
    const { r, s } = this
    if (!isWithinCurveOrder(r))
      throw new Error('Invalid Signature: r must be 0 < r < n')
    if (!isWithinCurveOrder(s))
      throw new Error('Invalid Signature: s must be 0 < s < n')
  }

  // Always false for canonical signatures.
  // We don't provide `hasHighR` for now even though some folks use it
  // https://github.com/bitcoin/bitcoin/pull/13666
  hasHighS(): boolean {
    const HALF = CURVE.n >> _1n
    return this.s > HALF
  }

  normalizeS(): Signature {
    return this.hasHighS() ? new Signature(this.r, CURVE.n - this.s) : this
  }

  // DER-encoded
  toDERRawBytes(isCompressed = false) {
    return hexToBytes(this.toDERHex(isCompressed))
  }

  toDERHex(isCompressed = false) {
    const sHex = sliceDER(numberToHex(this.s))
    if (isCompressed) return sHex
    const rHex = sliceDER(numberToHex(this.r))
    const rLen = numberToHex(rHex.length / 2)
    const sLen = numberToHex(sHex.length / 2)
    const length = numberToHex(rHex.length / 2 + sHex.length / 2 + 4)
    return `30${length}02${rLen}${rHex}02${sLen}${sHex}`
  }

  // Don't use these methods. Use toDER* or toCompact* for explicitness.
  toRawBytes() {
    return this.toDERRawBytes()
  }

  toHex() {
    return this.toDERHex()
  }

  // 32 bytes of r, then 32 bytes of s
  toCompactRawBytes() {
    return hexToBytes(this.toCompactHex())
  }

  toCompactHex() {
    return numTo32bStr(this.r) + numTo32bStr(this.s)
  }
}

// Concatenates several Uint8Arrays into one.
// TODO: check if we're copying data instead of moving it and if that's ok
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  if (!arrays.every(isUint8a)) throw new Error('Uint8Array list expected')
  if (arrays.length === 1) return arrays[0]
  const length = arrays.reduce((a, arr) => a + arr.length, 0)
  const result = new Uint8Array(length)
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const arr = arrays[i]
    result.set(arr, pad)
    pad += arr.length
  }
  return result
}

// Convert between types
// ---------------------

// We can't do `instanceof Uint8Array` because it's unreliable between Web Workers etc
function isUint8a(bytes: Uint8Array | unknown): bytes is Uint8Array {
  return bytes instanceof Uint8Array
}

const hexes = Array.from({ length: 256 }, (v, i) =>
  i.toString(16).padStart(2, '0')
)
function bytesToHex(uint8a: Uint8Array): string {
  if (!(uint8a instanceof Uint8Array)) throw new Error('Expected Uint8Array')
  // pre-caching improves the speed 6x
  let hex = ''
  for (let i = 0; i < uint8a.length; i++) {
    hex += hexes[uint8a[i]]
  }
  return hex
}

function numTo32bStr(num: number | bigint): string {
  if (num > POW_2_256) throw new Error('Expected number < 2^256')
  return num.toString(16).padStart(64, '0')
}

function numTo32b(num: bigint): Uint8Array {
  return hexToBytes(numTo32bStr(num))
}

function numberToHex(num: number | bigint): string {
  const hex = num.toString(16)
  return hex.length & 1 ? `0${hex}` : hex
}

function hexToNumber(hex: string): bigint {
  if (typeof hex !== 'string') {
    throw new TypeError('hexToNumber: expected string, got ' + typeof hex)
  }
  // Big Endian
  return BigInt(`0x${hex}`)
}

// Caching slows it down 2-3x
function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new TypeError('hexToBytes: expected string, got ' + typeof hex)
  }
  if (hex.length % 2)
    throw new Error('hexToBytes: received invalid unpadded hex' + hex.length)
  const array = new Uint8Array(hex.length / 2)
  for (let i = 0; i < array.length; i++) {
    const j = i * 2
    const hexByte = hex.slice(j, j + 2)
    const byte = Number.parseInt(hexByte, 16)
    if (Number.isNaN(byte) || byte < 0) throw new Error('Invalid byte sequence')
    array[i] = byte
  }
  return array
}

// Big Endian
function bytesToNumber(bytes: Uint8Array): bigint {
  return hexToNumber(bytesToHex(bytes))
}

function ensureBytes(hex: Hex): Uint8Array {
  // Uint8Array.from() instead of hash.slice() because node.js Buffer
  // is instance of Uint8Array, and its slice() creates **mutable** copy
  return hex instanceof Uint8Array ? Uint8Array.from(hex) : hexToBytes(hex)
}

function normalizeScalar(num: number | bigint): bigint {
  if (typeof num === 'number' && Number.isSafeInteger(num) && num > 0)
    return BigInt(num)
  if (typeof num === 'bigint' && isWithinCurveOrder(num)) return num
  throw new TypeError('Expected valid private scalar: 0 < scalar < curve.n')
}

// -------------------------

// Calculates a modulo b
function mod(a: bigint, b: bigint = CURVE.P): bigint {
  const result = a % b
  return result >= 0 ? result : b + result
}

// Does x ^ (2 ^ power). E.g. 30 ^ (2 ^ 4)
function pow2(x: bigint, power: bigint): bigint {
  const { P } = CURVE
  let res = x
  while (power-- > _0n) {
    res *= res
    res %= P
  }
  return res
}

// Used to calculate y - the square root of y².
// Exponentiates it to very big number (P+1)/4.
// We are unwrapping the loop because it's 2x faster.
// (P+1n/4n).toString(2) would produce bits [223x 1, 0, 22x 1, 4x 0, 11, 00]
// We are multiplying it bit-by-bit
function sqrtMod(x: bigint): bigint {
  const { P } = CURVE
  const _6n = BigInt(6)
  const _11n = BigInt(11)
  const _22n = BigInt(22)
  const _23n = BigInt(23)
  const _44n = BigInt(44)
  const _88n = BigInt(88)
  const b2 = (x * x * x) % P // x^3, 11
  const b3 = (b2 * b2 * x) % P // x^7
  const b6 = (pow2(b3, _3n) * b3) % P
  const b9 = (pow2(b6, _3n) * b3) % P
  const b11 = (pow2(b9, _2n) * b2) % P
  const b22 = (pow2(b11, _11n) * b11) % P
  const b44 = (pow2(b22, _22n) * b22) % P
  const b88 = (pow2(b44, _44n) * b44) % P
  const b176 = (pow2(b88, _88n) * b88) % P
  const b220 = (pow2(b176, _44n) * b44) % P
  const b223 = (pow2(b220, _3n) * b3) % P
  const t1 = (pow2(b223, _23n) * b22) % P
  const t2 = (pow2(t1, _6n) * b2) % P
  return pow2(t2, _2n)
}

// Inverses number over modulo
function invert(number: bigint, modulo: bigint = CURVE.P): bigint {
  if (number === _0n || modulo <= _0n) {
    throw new Error(
      `invert: expected positive integers, got n=${number} mod=${modulo}`
    )
  }
  // Eucledian GCD https://brilliant.org/wiki/extended-euclidean-algorithm/
  let a = mod(number, modulo)
  let b = modulo
  // prettier-ignore
  let x = _0n;
  let y = _1n
  let u = _1n
  let v = _0n
  while (a !== _0n) {
    const q = b / a
    const r = b % a
    const m = x - u * q
    const n = y - v * q
    // prettier-ignore
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b
  if (gcd !== _1n) throw new Error('invert: does not exist')
  return mod(x, modulo)
}

// Takes a bunch of numbers, inverses all of them
function invertBatch(nums: bigint[], n: bigint = CURVE.P): bigint[] {
  const len = nums.length
  const scratch = new Array(len)
  let acc = _1n
  for (let i = 0; i < len; i++) {
    if (nums[i] === _0n) continue
    scratch[i] = acc
    acc = mod(acc * nums[i], n)
  }
  acc = invert(acc, n)
  for (let i = len - 1; i >= 0; i--) {
    if (nums[i] === _0n) continue
    const tmp = mod(acc * nums[i], n)
    nums[i] = mod(acc * scratch[i], n)
    acc = tmp
  }
  return nums
}

const divNearest = (a: bigint, b: bigint) => (a + b / _2n) / b
const POW_2_128 = pow(_2n, BigInt(128))
// Split 256-bit K into 2 128-bit (k1, k2) for which k1 + k2 * lambda = K.
// Used for endomorphism https://gist.github.com/paulmillr/eb670806793e84df628a7c434a873066
function splitScalarEndo(k: bigint) {
  const { n } = CURVE
  const a1 = BigInt('0x3086d221a7d46bcde86c90e49284eb15')
  const b1 = -_1n * BigInt('0xe4437ed6010e88286f547fa90abfe4c3')
  const a2 = BigInt('0x114ca50f7a8e2f3f657c1108d9d44cfd8')
  const b2 = a1
  const c1 = divNearest(b2 * k, n)
  const c2 = divNearest(-b1 * k, n)
  let k1 = mod(k - c1 * a1 - c2 * a2, n)
  let k2 = mod(-c1 * b1 - c2 * b2, n)
  const k1neg = k1 > POW_2_128
  const k2neg = k2 > POW_2_128
  if (k1neg) k1 = n - k1
  if (k2neg) k2 = n - k2
  if (k1 > POW_2_128 || k2 > POW_2_128)
    throw new Error('splitScalarEndo: Endomorphism failed')
  return { k1neg, k1, k2neg, k2 }
}

// Ensures ECDSA message hashes are 32 bytes and < curve order
function truncateHash(hash: Uint8Array): bigint {
  const { n } = CURVE
  const byteLength = hash.length
  const delta = byteLength * 8 - 256 // size of curve.n
  let h = bytesToNumber(hash)
  if (delta > 0) h = h >> BigInt(delta)
  if (h >= n) h -= n
  return h
}

// RFC6979 related code
type RecoveredSig = { sig: Signature; recovery: number }
type U8A = Uint8Array

// Minimal HMAC-DRBG (NIST 800-90) for signatures
// Used only for RFC6979, does not fully implement DRBG spec.
class HmacDrbg {
  k: Uint8Array
  v: Uint8Array
  counter: number
  constructor() {
    // Step B, Step C
    this.v = new Uint8Array(32).fill(1)
    this.k = new Uint8Array(32).fill(0)
    this.counter = 0
  }

  private hmac(...values: Uint8Array[]) {
    return utils.hmacSha256(this.k, ...values)
  }

  private hmacSync(...values: Uint8Array[]) {
    if (typeof utils.hmacSha256Sync !== 'function')
      throw new Error('utils.hmacSha256Sync is undefined, you need to set it')
    const res = utils.hmacSha256Sync!(this.k, ...values)
    if (res instanceof Promise)
      throw new Error('To use sync sign(), ensure utils.hmacSha256 is sync')
    return res
  }

  incr() {
    if (this.counter >= 1000) {
      throw new Error('Tried 1,000 k values for sign(), all were invalid')
    }
    this.counter += 1
  }

  // We concatenate extraData into seed
  async reseed(seed = new Uint8Array()) {
    this.k = await this.hmac(this.v, Uint8Array.from([0x00]), seed)
    this.v = await this.hmac(this.v)
    if (seed.length === 0) return
    this.k = await this.hmac(this.v, Uint8Array.from([0x01]), seed)
    this.v = await this.hmac(this.v)
  }

  reseedSync(seed = new Uint8Array()) {
    this.k = this.hmacSync(this.v, Uint8Array.from([0x00]), seed)
    this.v = this.hmacSync(this.v)
    if (seed.length === 0) return
    this.k = this.hmacSync(this.v, Uint8Array.from([0x01]), seed)
    this.v = this.hmacSync(this.v)
  }

  async generate(): Promise<Uint8Array> {
    this.incr()
    this.v = await this.hmac(this.v)
    return this.v
  }

  generateSync(): Uint8Array {
    this.incr()
    this.v = this.hmacSync(this.v)
    return this.v
  }
  // There is no need in clean() method
  // It's useless, there are no guarantees with JS GC
  // whether bigints are removed even if you clean Uint8Arrays.
}

function isWithinCurveOrder(num: bigint): boolean {
  return _0n < num && num < CURVE.n
}

function isValidFieldElement(num: bigint): boolean {
  return _0n < num && num < CURVE.P
}

/**
 * Converts signature params into point & r/s, checks them for validity.
 * k must be in range [1, n-1]
 *
 * @param k signature's k param: deterministic in our case, random in non-rfc6979 sigs
 * @param m message that would be signed
 * @param d private key
 * @returns Signature with its point on curve Q OR undefined if params were invalid
 */
function kmdToSig(
  kBytes: Uint8Array,
  m: bigint,
  d: bigint
): RecoveredSig | undefined {
  const k = bytesToNumber(kBytes)
  if (!isWithinCurveOrder(k)) return
  // Important: all mod() calls in the function must be done over `n`
  const { n } = CURVE
  const q = Point.BASE.multiply(k)
  // r = x mod n
  const r = mod(q.x, n)
  if (r === _0n) return
  // s = (1/k * (m + dr) mod n
  const s = mod(invert(k, n) * mod(m + d * r, n), n)
  if (s === _0n) return
  const sig = new Signature(r, s)
  const recovery = (q.x === sig.r ? 0 : 2) | Number(q.y & _1n)
  return { sig, recovery }
}

function normalizePrivateKey(key: PrivKey): bigint {
  let num: bigint
  if (typeof key === 'bigint') {
    num = key
  } else if (typeof key === 'number' && Number.isSafeInteger(key) && key > 0) {
    num = BigInt(key)
  } else if (typeof key === 'string') {
    if (key.length !== 64) throw new Error('Expected 32 bytes of private key')
    num = hexToNumber(key)
  } else if (isUint8a(key)) {
    if (key.length !== 32) throw new Error('Expected 32 bytes of private key')
    num = bytesToNumber(key)
  } else {
    throw new TypeError('Expected valid private key')
  }
  if (!isWithinCurveOrder(num))
    throw new Error('Expected private key: 0 < key < n')
  return num
}

function normalizePublicKey(publicKey: PubKey): Point {
  if (publicKey instanceof Point) {
    publicKey.assertValidity()
    return publicKey
  } else {
    return Point.fromHex(publicKey)
  }
}

/**
 * Signatures can be in 64-byte compact representation,
 * or in (variable-length)-byte DER representation.
 * Since DER could also be 64 bytes, we check for it first.
 */
function normalizeSignature(signature: Sig): Signature {
  if (signature instanceof Signature) {
    signature.assertValidity()
    return signature
  }
  try {
    return Signature.fromDER(signature)
  } catch (error) {
    return Signature.fromCompact(signature)
  }
}

/**
 * Computes public key for secp256k1 private key.
 *
 * @param privateKey 32-byte private key
 * @param isCompressed whether to return full (65-byte), or compact (33-byte) key
 * @returns short/full public key
 */
export function getPublicKey(
  privateKey: PrivKey,
  isCompressed = false
): Uint8Array {
  return Point.fromPrivateKey(privateKey).toRawBytes(isCompressed)
}

/**
 * Recovers public key from signature and recovery bit.
 *
 * @param msgHash message hash
 * @param signature DER or compact sig
 * @param recovery 0 or 1
 * @returns Public key
 */
export function recoverPublicKey(
  msgHash: Hex,
  signature: Sig,
  recovery: number
): Uint8Array | undefined {
  return Point.fromSignature(msgHash, signature, recovery).toRawBytes()
}

function isPub(item: PrivKey | PubKey): boolean {
  const arr = isUint8a(item)
  const str = typeof item === 'string'
  const len = (arr || str) && (item as Hex).length
  if (arr) return len === 33 || len === 65
  if (str) return len === 66 || len === 130
  if (item instanceof Point) return true
  return false
}

/**
 * ECDH (Elliptic Curve Diffie Hellman) implementation.
 * 1. Checks for validity of private key
 * 2. Checks for the public key of being on-curve
 *
 * @param privateA private key
 * @param publicB different public key
 * @param isCompressed
 * @returns
 */
export function getSharedSecret(
  privateA: PrivKey,
  publicB: PubKey,
  isCompressed = false
): Uint8Array {
  if (isPub(privateA))
    throw new TypeError('getSharedSecret: first arg must be private key')
  if (!isPub(publicB))
    throw new TypeError('getSharedSecret: second arg must be public key')
  const b = normalizePublicKey(publicB)
  b.assertValidity()
  return b.multiply(normalizePrivateKey(privateA)).toRawBytes(isCompressed)
}

type Ent = Hex | true
type OptsRecov = {
  recovered: true
  canonical?: boolean
  der?: boolean
  extraEntropy?: Ent
}
type OptsNoRecov = {
  recovered?: false
  canonical?: boolean
  der?: boolean
  extraEntropy?: Ent
}
type Opts = {
  recovered?: boolean
  canonical?: boolean
  der?: boolean
  extraEntropy?: Ent
}
type SignOutput = Uint8Array | [Uint8Array, number]

// RFC6979 methods
function bits2int(bytes: Uint8Array) {
  const slice = bytes.length > 32 ? bytes.slice(0, 32) : bytes
  return bytesToNumber(slice)
}
function bits2octets(bytes: Uint8Array): Uint8Array {
  const z1 = bits2int(bytes)
  const z2 = mod(z1, CURVE.n)
  return int2octets(z2 < _0n ? z1 : z2)
}
function int2octets(num: bigint): Uint8Array {
  if (typeof num !== 'bigint') throw new Error('Expected bigint')
  const hex = numTo32bStr(num) // prohibits >32 bytes
  return hexToBytes(hex)
}

// Steps A, D of RFC6979 3.2
// Creates RFC6979 seed; converts msg/privKey to numbers.
function initSigArgs(msgHash: Hex, privateKey: PrivKey, extraEntropy?: Ent) {
  if (msgHash == null)
    throw new Error(`sign: expected valid message hash, not "${msgHash}"`)
  // Step A is ignored, since we already provide hash instead of msg
  const h1 = ensureBytes(msgHash)
  const d = normalizePrivateKey(privateKey)
  // K = HMAC_K(V || 0x00 || int2octets(x) || bits2octets(h1) || k')
  const seedArgs = [int2octets(d), bits2octets(h1)]
  // RFC6979 3.6: additional k' could be provided
  if (extraEntropy != null) {
    if (extraEntropy === true) extraEntropy = utils.randomBytes(32)
    const e = ensureBytes(extraEntropy)
    if (e.length !== 32)
      throw new Error('sign: Expected 32 bytes of extra data')
    seedArgs.push(e)
  }
  // seed is constructed from private key and message
  // Step D
  // V, 0x00 are done in HmacDRBG constructor.
  const seed = concatBytes(...seedArgs)
  const m = bits2int(h1)
  return { seed, m, d }
}

// Takes signature with its recovery bit, normalizes it
// Produces DER/compact signature and proper recovery bit
function finalizeSig(
  recSig: RecoveredSig,
  opts: OptsNoRecov | OptsRecov
): SignOutput {
  let { sig, recovery } = recSig
  const { canonical, der, recovered } = Object.assign(
    { canonical: true, der: true },
    opts
  )
  if (canonical && sig.hasHighS()) {
    sig = sig.normalizeS()
    recovery ^= 1
  }
  const hashed = der ? sig.toDERRawBytes() : sig.toCompactRawBytes()
  return recovered ? [hashed, recovery] : hashed
}

/**
 * Signs message hash (not message: you need to hash it by yourself).
 * We don't auto-hash because some users would want non-SHA256 hash.
 * We are always using deterministic signatures (RFC6979 3.1) instead of
 * letting user specify random k.
 * HMAC-DRBG generates k, then calculates sig point Q & signature r, s based on it.
 * Could receive extra entropy k' as per RFC6979 3.6 Additional data.
 * k' is not generated by default, because of backwards-compatibility concerns.
 * We strongly recommend to pass {extraEntropy: true}.
 *
 * low-s signatures are generated by default. If you don't want it, use canonical: false.
 *
 * ```
 * sign(m, d, k) where
 *   (x, y) = G × k
 *   r = x mod n
 *   s = (1/k * (m + dr) mod n
 * ```
 *
 * @param opts recovered, canonical, der, extraEntropy
 */
async function sign(
  msgHash: Hex,
  privKey: PrivKey,
  opts: OptsRecov
): Promise<[U8A, number]>
async function sign(
  msgHash: Hex,
  privKey: PrivKey,
  opts?: OptsNoRecov
): Promise<U8A>
async function sign(
  msgHash: Hex,
  privKey: PrivKey,
  opts: Opts = {}
): Promise<SignOutput> {
  // Steps A, D of RFC6979 3.2.
  const { seed, m, d } = initSigArgs(msgHash, privKey, opts.extraEntropy)
  let sig: RecoveredSig | undefined
  // Steps B, C, D, E, F, G
  const drbg = new HmacDrbg()
  await drbg.reseed(seed)
  // Step H3, repeat until k is in range [1, n-1]
  while (!(sig = kmdToSig(await drbg.generate(), m, d))) await drbg.reseed()
  return finalizeSig(sig, opts)
}

// Two methods because some people cannot use async sign
function signSync(
  msgHash: Hex,
  privKey: PrivKey,
  opts: OptsRecov
): [U8A, number]
function signSync(msgHash: Hex, privKey: PrivKey, opts?: OptsNoRecov): U8A
function signSync(msgHash: Hex, privKey: PrivKey, opts: Opts = {}): SignOutput {
  // Steps A, D of RFC6979 3.2.
  const { seed, m, d } = initSigArgs(msgHash, privKey, opts.extraEntropy)
  let sig: RecoveredSig | undefined
  // Steps B, C, D, E, F, G
  const drbg = new HmacDrbg()
  drbg.reseedSync(seed)
  // Step H3, repeat until k is in range [1, n-1]
  while (!(sig = kmdToSig(drbg.generateSync(), m, d))) drbg.reseedSync()
  return finalizeSig(sig, opts)
}
export { sign, signSync }

type VOpts = {
  strict?: boolean
}
const vopts: VOpts = { strict: true }

/**
 * Verifies a signature against message hash and public key.
 * Rejects high-s signatures by default. Use strict opt to override.
 * https://www.secg.org/sec1-v2.pdf, section 4.1.4.
 *
 * ```
 * verify(r, s, m, P) where
 *   w = 1/s mod n
 *   u1 = mw mod n
 *   u2 = rw mod n
 *   (x2, y2) = G × u1 + P × u2
 *   x2 == r
 * ```
 */
export function verify(
  signature: Sig,
  msgHash: Hex,
  publicKey: PubKey,
  opts = vopts
): boolean {
  let sig
  try {
    sig = normalizeSignature(signature)
    msgHash = ensureBytes(msgHash)
  } catch (error) {
    return false
  }
  const { r, s } = sig
  if (opts.strict && sig.hasHighS()) return false
  const h = truncateHash(msgHash)

  // Non-standard behavior: Probably forged, protect against fault attacks.
  if (h === _0n) return false
  let pubKey
  try {
    pubKey = JacobianPoint.fromAffine(normalizePublicKey(publicKey))
  } catch (error) {
    return false
  }
  const { n } = CURVE
  const s1 = invert(s, n) // s^-1
  const u1 = mod(h * s1, n)
  const u2 = mod(r * s1, n)
  const Ghs1 = JacobianPoint.BASE.multiply(u1)
  const Prs1 = pubKey.multiplyUnsafe(u2)
  const R = Ghs1.add(Prs1).toAffine()
  const v = mod(R.x, n)
  return v === r
}

// Schnorr-specific code as per BIP0340.

// Strip first byte that signifies whether y is positive or negative, leave only x.
async function taggedHash(
  tag: string,
  ...messages: Uint8Array[]
): Promise<bigint> {
  const tagB = new Uint8Array(tag.split('').map((c) => c.charCodeAt(0)))
  const tagH = await utils.sha256(tagB)
  const h = await utils.sha256(concatBytes(tagH, tagH, ...messages))
  return bytesToNumber(h)
}

async function createChallenge(x: bigint, P: Point, message: Uint8Array) {
  const rx = numTo32b(x)
  const t = await taggedHash('BIP0340/challenge', rx, P.toRawX(), message)
  return mod(t, CURVE.n)
}

function hasEvenY(point: Point) {
  return mod(point.y, _2n) === _0n
}

class SchnorrSignature {
  constructor(readonly r: bigint, readonly s: bigint) {
    if (!isValidFieldElement(r) || !isWithinCurveOrder(s))
      throw new Error('Invalid signature')
  }

  static fromHex(hex: Hex) {
    const bytes = ensureBytes(hex)
    if (bytes.length !== 64)
      throw new TypeError(
        `SchnorrSignature.fromHex: expected 64 bytes, not ${bytes.length}`
      )
    const r = bytesToNumber(bytes.slice(0, 32))
    const s = bytesToNumber(bytes.slice(32, 64))
    return new SchnorrSignature(r, s)
  }

  toHex(): string {
    return numTo32bStr(this.r) + numTo32bStr(this.s)
  }

  toRawBytes(): Uint8Array {
    return hexToBytes(this.toHex())
  }
}

// Schnorr's pubkey is just `x` of Point
// BIP340
function schnorrGetPublicKey(privateKey: PrivKey): Uint8Array {
  return Point.fromPrivateKey(privateKey).toRawX()
}

// Schnorr signature verifies itself before producing an output, which makes it safer
async function schnorrSign(
  message: Hex,
  privateKey: PrivKey,
  auxRand: Hex = utils.randomBytes()
): Promise<Uint8Array> {
  if (message == null)
    throw new TypeError(`sign: Expected valid message, not "${message}"`)
  const { n } = CURVE
  const m = ensureBytes(message)
  const d0 = normalizePrivateKey(privateKey) // <== does isWithinCurveOrder check
  const rand = ensureBytes(auxRand)
  if (rand.length !== 32)
    throw new TypeError('sign: Expected 32 bytes of aux randomness')

  const P = Point.fromPrivateKey(d0)
  const d = hasEvenY(P) ? d0 : n - d0

  const t0h = await taggedHash('BIP0340/aux', rand)
  const t = d ^ t0h

  const k0h = await taggedHash('BIP0340/nonce', numTo32b(t), P.toRawX(), m)
  const k0 = mod(k0h, n)
  if (k0 === _0n)
    throw new Error('sign: Creation of signature failed. k is zero')

  // R = k'⋅G
  const R = Point.fromPrivateKey(k0)
  const k = hasEvenY(R) ? k0 : n - k0
  const e = await createChallenge(R.x, P, m)
  const sig = new SchnorrSignature(R.x, mod(k + e * d, n))
  const isValid = await schnorrVerify(sig.toRawBytes(), m, P.toRawX())

  if (!isValid) throw new Error('sign: Invalid signature produced')
  return sig.toRawBytes()
}

// no schnorrSignSync() for now

// Also used in sign() function.
async function schnorrVerify(
  signature: Hex,
  message: Hex,
  publicKey: Hex
): Promise<boolean> {
  const sig =
    signature instanceof SchnorrSignature
      ? signature
      : SchnorrSignature.fromHex(signature)
  const m = ensureBytes(message)

  const P = normalizePublicKey(publicKey)
  const e = await createChallenge(sig.r, P, m)

  // R = s⋅G - e⋅P
  const sG = Point.fromPrivateKey(sig.s)
  const eP = P.multiply(e)
  const R = sG.subtract(eP)

  if (R.equals(Point.BASE) || !hasEvenY(R) || R.x !== sig.r) return false
  return true
}

export const schnorr = {
  Signature: SchnorrSignature,
  getPublicKey: schnorrGetPublicKey,
  sign: schnorrSign,
  verify: schnorrVerify,
}

// Enable precomputes. Slows down first publicKey computation by 20ms.
Point.BASE._setWindowSize(8)

type Sha256FnSync = undefined | ((...messages: Uint8Array[]) => Uint8Array)
type HmacFnSync =
  | undefined
  | ((key: Uint8Array, ...messages: Uint8Array[]) => Uint8Array)

// Global symbol available in browsers only. Ensure we do not depend on @types/dom
declare const self: Record<string, any> | undefined
const crypto: { node?: any; web?: any } = {
  node: nodeCrypto,
  web: typeof self === 'object' && 'crypto' in self ? self.crypto : undefined,
}

export const utils = {
  isValidPrivateKey(privateKey: PrivKey) {
    try {
      normalizePrivateKey(privateKey)
      return true
    } catch (error) {
      return false
    }
  },

  randomBytes: (bytesLength = 32): Uint8Array => {
    if (crypto.web) {
      return crypto.web.getRandomValues(new Uint8Array(bytesLength))
    } else if (crypto.node) {
      const { randomBytes } = crypto.node
      return Uint8Array.from(randomBytes(bytesLength))
    } else {
      throw new Error("The environment doesn't have randomBytes function")
    }
  },

  // NIST SP 800-56A rev 3, section 5.6.1.2.2
  // https://research.kudelskisecurity.com/2020/07/28/the-definitive-guide-to-modulo-bias-and-how-to-avoid-it/
  randomPrivateKey: (): Uint8Array => {
    let i = 8
    while (i--) {
      const b32 = utils.randomBytes(32)
      const num = bytesToNumber(b32)
      if (isWithinCurveOrder(num) && num !== _1n) return b32
    }
    throw new Error(
      'Valid private key was not found in 8 iterations. PRNG is broken'
    )
  },

  bytesToHex,
  mod,

  sha256: async (message: Uint8Array): Promise<Uint8Array> => {
    if (crypto.web) {
      const buffer = await crypto.web.subtle.digest('SHA-256', message.buffer)
      return new Uint8Array(buffer)
    } else if (crypto.node) {
      const { createHash } = crypto.node
      return Uint8Array.from(createHash('sha256').update(message).digest())
    } else {
      throw new Error("The environment doesn't have sha256 function")
    }
  },

  hmacSha256: async (
    key: Uint8Array,
    ...messages: Uint8Array[]
  ): Promise<Uint8Array> => {
    if (crypto.web) {
      // prettier-ignore
      const ckey = await crypto.web.subtle.importKey(
        'raw', key, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']
      );
      const message = concatBytes(...messages)
      const buffer = await crypto.web.subtle.sign('HMAC', ckey, message)
      return new Uint8Array(buffer)
    } else if (crypto.node) {
      const { createHmac } = crypto.node
      const hash = createHmac('sha256', key)
      messages.forEach((m) => hash.update(m))
      return Uint8Array.from(hash.digest())
    } else {
      throw new Error("The environment doesn't have hmac-sha256 function")
    }
  },

  sha256Sync: undefined as Sha256FnSync,
  hmacSha256Sync: undefined as HmacFnSync,

  precompute(windowSize = 8, point = Point.BASE): Point {
    const cached = point === Point.BASE ? point : new Point(point.x, point.y)
    cached._setWindowSize(windowSize)
    cached.multiply(_3n)
    return cached
  },
}
