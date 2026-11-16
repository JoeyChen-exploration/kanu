---
name: design-references
description: "涉及 UI、动效（动画/交互细节）实现的任务时参考——一份跨项目通用的动效/UI 设计素材库，包含灵感参考站和可直接抠代码的组件库，以及怎么用这些素材的规则"
metadata:
  type: reference
---

## 素材库列表

- **[Codrops](https://tympanus.net/codrops/)** —— 可直接抠代码。教程站，几乎每篇动效/交互文章都配 CodePen 或 GitHub 仓库的完整源码，可以直接看实现细节甚至搬用。
- **[Awwwards GSAP 分类](https://www.awwwards.com/websites/gsap/)** —— 灵感参考。获奖网站的成品展示墙，看到的是上线后的真实效果，没有源码，只能靠开发者工具扒思路，适合找"这类动效长什么样"的灵感。
- **[Magic UI](https://magicui.design/)** —— 可直接抠代码。React + Tailwind + Framer Motion 的动效组件库，官网直接提供可复制粘贴的组件代码。
- **[Aceternity UI](https://ui.aceternity.com/)** —— 可直接抠代码。同类型的动效组件库（Tailwind + Framer Motion 为主），组件页面自带完整源码可复制。
- **[littlebigdetails.com](https://littlebigdetails.com/)** —— 灵感参考。收录真实产品里的小交互细节（截图/动图形式），没有代码，用来培养"这个细节为什么让人舒服"的判断力。
- **[Taste Skill](https://github.com/Leonxlnx/taste-skill)** —— 不是网站，是一个 Claude Code skill，反 AI 套版的设计规则集。**只适用于 landing page / portfolio / redesign**，不适用于卡奴这种游戏界面，所以没装进卡奴；以后做官网或宣传页时可以单独装。

## 怎么用：蒸馏，不要照搬

看到一个想用的动效，先做三步分析，再决定要不要用、怎么用：

1. **它解决了什么交互问题**——是引导视线、反馈状态变化、增加层次感，还是纯装饰？说不清楚解决了什么问题的动效，大概率不该抄。
2. **性能实现方式**——检查（或推断）它是否用 `transform`/`opacity` 这类只触发合成层的高性能属性实现，而不是触发 layout/paint 的属性（如 `width`/`top`/`left`/`margin`）。如果原实现性能不好，改造时要换成高性能属性，不要原样照搬。
3. **是否符合当前项目的克制程度**——对照全局风格偏好（新 UI 默认克制、极简、premium，不做大红大紫的促销风），判断这个动效的幅度/时长/花哨程度要不要收敛。

确认可用后，按当前项目的技术栈重新实现（不是复制粘贴 Magic UI/Aceternity UI 的代码简单换皮），并在代码注释或 PR 描述里注明参考来源（例如"卡片 hover 位移参考 Aceternity UI 的某个组件，调整为更克制的幅度"）。

## 默认动效库：待项目指定

不要假设某个具体项目用 Framer Motion 还是 GSAP 还是别的。进入具体项目做动效任务时：

- 先看项目已有依赖（package.json）里有没有现成的动效库；
- 没有的话再问用户要用哪个，不要自己默认选一个。

## 追加新素材站

以后用户直接说一个新的素材站名字，就按上面「素材库列表」同样的格式（网站名 + 链接 + 灵感参考/可直接抠代码 + 一句简介）追加进列表，不用重新确认存储形式或格式。
