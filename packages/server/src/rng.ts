// 线上用的随机源：crypto.randomInt（FR-PACK-9：所有随机数在服务器生成）。game/ 只认 Rng 接口，不直接 import 这里。
import crypto from 'node:crypto';
import type { Rng } from './game/rng.ts';

export const cryptoRng: Rng = { int: (max) => crypto.randomInt(max) };
