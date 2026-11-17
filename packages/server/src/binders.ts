// 卡册（DESIGN 4.5）：放卡、自动整理、库存上限、磨损、卡册效果。只能在数据库事务里调用（调用方开事务）。
import { BINDERS, LOOSE, STARTER_BINDER, type BinderKind, type CustomerType } from '@kanu/shared/balance';
import type { Repo } from './db/index.ts';
import type { Rng } from './game/rng.ts';
import { wearOnce } from './game/wear.ts';

export type BinderService = ReturnType<typeof createBinderService>;

export function createBinderService(repo: Repo, rng: Rng) {
  const capacity = (kind: string) => BINDERS[kind as BinderKind]?.slots ?? 0;

  /** 还有空位的卡册，按买的先后 */
  const openBinders = (ownerId: string) =>
    repo.bindersOf(ownerId).map((b) => ({ ...b, free: capacity(b.kind) - b.used })).filter((b) => b.free > 0);

  const svc = {
    /** 第一次进来送一本简易卡册，顺便把散放的老卡收进去 */
    ensureStarter(ownerId: string, now: number, day: number) {
      if (repo.bindersOf(ownerId).length === 0) {
        repo.insertBinder(ownerId, STARTER_BINDER, now);
        svc.autoFill(ownerId, day);
      }
    },

    /** 把桌面上的散卡按市场价从高到低收进有空位的卡册；收不下的留在桌面，补上开始散放的日子 */
    autoFill(ownerId: string, day: number) {
      const loose = repo.looseCards(ownerId).sort((a, b) => b.price - a.price);
      const binders = openBinders(ownerId);
      let i = 0;
      for (const b of binders) {
        for (let k = 0; k < b.free && i < loose.length; k += 1, i += 1) repo.placeCard(loose[i]!.id, b.id, null);
      }
      for (; i < loose.length; i += 1) if (loose[i]!.looseSinceDay === null) repo.placeCard(loose[i]!.id, null, day);
      return { placed: Math.min(loose.length, binders.reduce((n, b) => n + b.free, 0)) };
    },

    /** 新卡放哪：有空位的卡册优先，满了就散放在桌面上 */
    placeNew(ownerId: string, cardIds: number[], day: number) {
      const binders = openBinders(ownerId);
      let bi = 0;
      for (const id of cardIds) {
        while (bi < binders.length && binders[bi]!.free === 0) bi += 1;
        if (bi < binders.length) {
          repo.placeCard(id, binders[bi]!.id, null);
          binders[bi]!.free -= 1;
        } else {
          repo.placeCard(id, null, day);
        }
      }
    },

    /** 还能放下几张新卡（卡册空位 + 桌面空位） */
    space(ownerId: string) {
      const binderFree = openBinders(ownerId).reduce((n, b) => n + b.free, 0);
      const looseFree = Math.max(0, LOOSE.slots - repo.looseCards(ownerId).length);
      return { binderFree, looseFree, total: binderFree + looseFree };
    },

    /** 打烊时：桌面上每张散卡按概率磨损（只改隐藏的品相）；返回磨损了几张（只给日志用） */
    wear(ownerId: string) {
      let worn = 0;
      for (const inst of repo.looseInstances(ownerId)) {
        const next = wearOnce(rng, inst.grade);
        if (next !== inst.grade) { repo.setGrade(inst.id, next); worn += 1; }
      }
      return worn;
    },

    /** 放在某本卡册里的卡卖给这类顾客时，心理价位乘多少 */
    priceMultiplier(ownerId: string, binderId: number | null, type: CustomerType) {
      if (binderId === null) return 1;
      const b = repo.getBinder(ownerId, binderId);
      if (!b) return 1;
      const spec = BINDERS[b.kind as BinderKind];
      return 1 + spec.allBonus + (type === 'collector' ? spec.collectorBonus : 0);
    },

    /** 拥有的卡册带来的每日额外收藏家（同种不叠加） */
    extraCollectors(ownerId: string) {
      const kinds = new Set(repo.bindersOf(ownerId).map((b) => b.kind as BinderKind));
      return [...kinds].reduce((n, k) => n + BINDERS[k].extraCollectors, 0);
    },
  };
  return svc;
}
