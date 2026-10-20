/*
Copyright (c) 2026 SUMOMO

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/
// Adapted from SUMOMO UI Library v33, 2026-10-16. Copyright (c) 2026 SUMOMO.
// MIT notice and source hashes: ../../../upstream/. No UI-library runtime imports.
// These are visual data only. Game geometry, semantic colors and storage belong
// to their existing product owners; gap/fontSize are retained but not projected.

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const APPEARANCE_STYLES = deepFreeze([
  {
    "id": "paper",
    "label": "纸感"
  },
  {
    "id": "glass",
    "label": "玻璃"
  },
  {
    "id": "soft",
    "label": "柔感"
  }
]);

export const APPEARANCE_SCHEMA = deepFreeze({
  "paper": [
    {
      "key": "radius",
      "label": "控件圆角",
      "min": 0,
      "max": 28,
      "step": 1,
      "value": 6,
      "unit": "px",
      "css": "--ui-radius",
      "group": "外形"
    },
    {
      "key": "gap",
      "label": "内部留白",
      "min": 8,
      "max": 24,
      "step": 1,
      "value": 14,
      "unit": "px",
      "css": "--ui-gap",
      "group": "外形"
    },
    {
      "key": "accent",
      "label": "强调色",
      "css": "--ui-accent",
      "type": "color",
      "group": "配色",
      "value": "#80024e"
    },
    {
      "key": "ink",
      "label": "主要文字",
      "css": "--ui-ink",
      "type": "color",
      "group": "配色",
      "value": "#393733"
    },
    {
      "key": "muted",
      "label": "辅助文字",
      "css": "--ui-muted",
      "type": "color",
      "group": "配色",
      "value": "#777168"
    },
    {
      "key": "surface",
      "label": "表面底色",
      "css": "--ui-surface-color",
      "type": "color",
      "group": "配色",
      "value": "#fcfaf5"
    },
    {
      "key": "motion",
      "label": "动效方式",
      "group": "动效",
      "type": "choice",
      "options": [
        {
          "value": 0,
          "label": "关闭"
        },
        {
          "value": 1,
          "label": "轻盈"
        },
        {
          "value": 2,
          "label": "利落"
        }
      ],
      "min": 0,
      "max": 2,
      "step": 1,
      "value": 1,
      "unit": "",
      "css": "--motion-mode"
    },
    {
      "key": "duration",
      "label": "动效时长",
      "group": "动效",
      "min": 80,
      "max": 400,
      "step": 10,
      "value": 240,
      "unit": "ms",
      "css": "--motion-duration"
    },
    {
      "key": "easing",
      "label": "速度曲线",
      "group": "动效",
      "type": "choice",
      "options": [
        {
          "value": 0,
          "label": "标准"
        },
        {
          "value": 1,
          "label": "柔和"
        },
        {
          "value": 2,
          "label": "直接"
        }
      ],
      "min": 0,
      "max": 2,
      "step": 1,
      "value": 0,
      "unit": "",
      "css": "--motion-easing"
    },
    {
      "key": "distance",
      "label": "位移幅度",
      "group": "动效",
      "min": 0,
      "max": 12,
      "step": 1,
      "value": 6,
      "unit": "px",
      "css": "--motion-distance"
    }
  ],
  "glass": [
    {
      "key": "radius",
      "label": "面板圆角",
      "group": "外形",
      "min": 0,
      "max": 40,
      "step": 1,
      "value": 24,
      "unit": "px",
      "css": "--ui-radius"
    },
    {
      "key": "gap",
      "label": "内部留白",
      "group": "外形",
      "min": 8,
      "max": 28,
      "step": 1,
      "value": 16,
      "unit": "px",
      "css": "--ui-gap"
    },
    {
      "key": "opacity",
      "label": "表面浓度",
      "group": "材质",
      "min": 8,
      "max": 85,
      "step": 1,
      "value": 22,
      "unit": "%",
      "css": "--glass-opacity"
    },
    {
      "key": "blur",
      "label": "磨砂程度",
      "group": "材质",
      "min": 0,
      "max": 30,
      "step": 1,
      "value": 16,
      "unit": "px",
      "css": "--glass-blur"
    },
    {
      "key": "saturation",
      "label": "背景饱和度",
      "group": "材质",
      "min": 50,
      "max": 180,
      "step": 1,
      "value": 108,
      "unit": "%",
      "css": "--glass-saturation"
    },
    {
      "key": "highlight",
      "label": "边缘高光",
      "group": "材质",
      "min": 0,
      "max": 100,
      "step": 1,
      "value": 34,
      "unit": "%",
      "css": "--glass-highlight"
    },
    {
      "key": "shadow",
      "label": "投影范围",
      "group": "材质",
      "min": 0,
      "max": 70,
      "step": 1,
      "value": 34,
      "unit": "px",
      "css": "--glass-shadow"
    },
    {
      "key": "protection",
      "label": "阅读保护",
      "group": "文字",
      "min": 0,
      "max": 85,
      "step": 1,
      "value": 20,
      "unit": "%",
      "css": "--glass-protection"
    },
    {
      "key": "fontSize",
      "label": "文字大小",
      "group": "文字",
      "min": 12,
      "max": 19,
      "step": 1,
      "value": 14,
      "unit": "px",
      "css": "--glass-font-size"
    },
    {
      "key": "background",
      "label": "背景预设",
      "group": "背景",
      "type": "choice",
      "options": [
        {
          "value": 0,
          "label": "日光"
        },
        {
          "value": 1,
          "label": "暮色"
        },
        {
          "value": 2,
          "label": "高对比"
        },
        {
          "value": 3,
          "label": "暖白窗影"
        },
        {
          "value": 4,
          "label": "植物投影"
        },
        {
          "value": 5,
          "label": "雾山远景"
        },
        {
          "value": 6,
          "label": "彩色光斑"
        },
        {
          "value": 7,
          "label": "黑白构成"
        }
      ],
      "min": 0,
      "max": 7,
      "step": 1,
      "value": 0,
      "unit": "",
      "css": "--glass-background"
    },
    {
      "key": "refraction",
      "label": "边缘折射",
      "group": "高级光学",
      "min": 0,
      "max": 30,
      "step": 1,
      "value": 8,
      "unit": "px",
      "css": "--glass-refraction",
      "help": "SVG 背景位移为渐进增强；不支持的浏览器保留清楚的磨砂。"
    },
    {
      "key": "accent",
      "label": "强调色",
      "css": "--ui-accent",
      "type": "color",
      "group": "配色",
      "value": "#595675"
    },
    {
      "key": "ink",
      "label": "主要文字",
      "css": "--ui-ink",
      "type": "color",
      "group": "配色",
      "value": "#343944"
    },
    {
      "key": "muted",
      "label": "辅助文字",
      "css": "--ui-muted",
      "type": "color",
      "group": "配色",
      "value": "#46524f"
    },
    {
      "key": "surface",
      "label": "表面底色",
      "css": "--ui-surface-color",
      "type": "color",
      "group": "配色",
      "value": "#ffffff"
    },
    {
      "key": "motion",
      "label": "动效方式",
      "group": "动效",
      "type": "choice",
      "options": [
        {
          "value": 0,
          "label": "关闭"
        },
        {
          "value": 1,
          "label": "轻盈"
        },
        {
          "value": 2,
          "label": "利落"
        }
      ],
      "min": 0,
      "max": 2,
      "step": 1,
      "value": 1,
      "unit": "",
      "css": "--motion-mode"
    },
    {
      "key": "duration",
      "label": "动效时长",
      "group": "动效",
      "min": 80,
      "max": 400,
      "step": 10,
      "value": 240,
      "unit": "ms",
      "css": "--motion-duration"
    },
    {
      "key": "easing",
      "label": "速度曲线",
      "group": "动效",
      "type": "choice",
      "options": [
        {
          "value": 0,
          "label": "标准"
        },
        {
          "value": 1,
          "label": "柔和"
        },
        {
          "value": 2,
          "label": "直接"
        }
      ],
      "min": 0,
      "max": 2,
      "step": 1,
      "value": 0,
      "unit": "",
      "css": "--motion-easing"
    },
    {
      "key": "distance",
      "label": "位移幅度",
      "group": "动效",
      "min": 0,
      "max": 12,
      "step": 1,
      "value": 6,
      "unit": "px",
      "css": "--motion-distance"
    }
  ],
  "soft": [
    {
      "key": "radius",
      "label": "控件圆角",
      "min": 0,
      "max": 28,
      "step": 1,
      "value": 18,
      "unit": "px",
      "css": "--ui-radius",
      "group": "外形"
    },
    {
      "key": "gap",
      "label": "内部留白",
      "min": 8,
      "max": 24,
      "step": 1,
      "value": 18,
      "unit": "px",
      "css": "--ui-gap",
      "group": "外形"
    },
    {
      "key": "accent",
      "label": "强调色",
      "css": "--ui-accent",
      "type": "color",
      "group": "配色",
      "value": "#7d4968"
    },
    {
      "key": "ink",
      "label": "主要文字",
      "css": "--ui-ink",
      "type": "color",
      "group": "配色",
      "value": "#514953"
    },
    {
      "key": "muted",
      "label": "辅助文字",
      "css": "--ui-muted",
      "type": "color",
      "group": "配色",
      "value": "#6b626e"
    },
    {
      "key": "surface",
      "label": "表面底色",
      "css": "--ui-surface-color",
      "type": "color",
      "group": "配色",
      "value": "#e9e5e8"
    },
    {
      "key": "motion",
      "label": "动效方式",
      "group": "动效",
      "type": "choice",
      "options": [
        {
          "value": 0,
          "label": "关闭"
        },
        {
          "value": 1,
          "label": "轻盈"
        },
        {
          "value": 2,
          "label": "利落"
        }
      ],
      "min": 0,
      "max": 2,
      "step": 1,
      "value": 1,
      "unit": "",
      "css": "--motion-mode"
    },
    {
      "key": "duration",
      "label": "动效时长",
      "group": "动效",
      "min": 80,
      "max": 400,
      "step": 10,
      "value": 240,
      "unit": "ms",
      "css": "--motion-duration"
    },
    {
      "key": "easing",
      "label": "速度曲线",
      "group": "动效",
      "type": "choice",
      "options": [
        {
          "value": 0,
          "label": "标准"
        },
        {
          "value": 1,
          "label": "柔和"
        },
        {
          "value": 2,
          "label": "直接"
        }
      ],
      "min": 0,
      "max": 2,
      "step": 1,
      "value": 0,
      "unit": "",
      "css": "--motion-easing"
    },
    {
      "key": "distance",
      "label": "位移幅度",
      "group": "动效",
      "min": 0,
      "max": 12,
      "step": 1,
      "value": 6,
      "unit": "px",
      "css": "--motion-distance"
    }
  ]
});

export const APPEARANCE_PRESETS = deepFreeze([
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-paper-editorial",
    "name": "暖纸 · 原样",
    "styleId": "paper",
    "origin": "curated",
    "tokens": {
      "radius": 6,
      "gap": 14,
      "accent": "#80024e",
      "ink": "#393733",
      "muted": "#777168",
      "surface": "#fcfaf5",
      "motion": 1,
      "duration": 240,
      "easing": 0,
      "distance": 6
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-paper-archive",
    "name": "石墨 · 档案",
    "styleId": "paper",
    "origin": "curated",
    "tokens": {
      "radius": 2,
      "gap": 12,
      "accent": "#202020",
      "ink": "#202020",
      "muted": "#646464",
      "surface": "#f9f9f9",
      "motion": 2,
      "duration": 160,
      "easing": 2,
      "distance": 3
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-paper-ocean",
    "name": "海蓝 · 舒展",
    "styleId": "paper",
    "origin": "curated",
    "tokens": {
      "radius": 10,
      "gap": 20,
      "accent": "#0d73cc",
      "ink": "#1c2024",
      "muted": "#60646c",
      "surface": "#f9f9fb",
      "motion": 1,
      "duration": 280,
      "easing": 1,
      "distance": 7
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-glass-daylight",
    "name": "日光 · 通透",
    "styleId": "glass",
    "origin": "curated",
    "tokens": {
      "radius": 24,
      "gap": 16,
      "opacity": 22,
      "blur": 16,
      "saturation": 108,
      "highlight": 34,
      "shadow": 34,
      "protection": 20,
      "fontSize": 14,
      "background": 0,
      "refraction": 8,
      "accent": "#595675",
      "ink": "#343944",
      "muted": "#46524f",
      "surface": "#ffffff",
      "motion": 1,
      "duration": 240,
      "easing": 0,
      "distance": 6
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-glass-dusk",
    "name": "暮色 · 轻盈",
    "styleId": "glass",
    "origin": "curated",
    "tokens": {
      "radius": 26,
      "gap": 18,
      "opacity": 30,
      "blur": 18,
      "saturation": 108,
      "highlight": 32,
      "shadow": 32,
      "protection": 32,
      "fontSize": 14,
      "background": 1,
      "refraction": 6,
      "accent": "#008472",
      "ink": "#1a211e",
      "muted": "#445452",
      "surface": "#ffffff",
      "motion": 1,
      "duration": 300,
      "easing": 1,
      "distance": 8
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-glass-reading",
    "name": "阅读 · 清晰",
    "styleId": "glass",
    "origin": "curated",
    "tokens": {
      "radius": 18,
      "gap": 16,
      "opacity": 56,
      "blur": 18,
      "saturation": 108,
      "highlight": 22,
      "shadow": 20,
      "protection": 44,
      "fontSize": 15,
      "background": 0,
      "refraction": 2,
      "accent": "#202020",
      "ink": "#202020",
      "muted": "#4d5553",
      "surface": "#ffffff",
      "motion": 2,
      "duration": 180,
      "easing": 2,
      "distance": 3
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-soft-quiet",
    "name": "梅紫 · 原样",
    "styleId": "soft",
    "origin": "curated",
    "tokens": {
      "radius": 18,
      "gap": 18,
      "accent": "#7d4968",
      "ink": "#514953",
      "muted": "#6b626e",
      "surface": "#e9e5e8",
      "motion": 1,
      "duration": 240,
      "easing": 0,
      "distance": 6
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-soft-sage",
    "name": "松绿 · 舒展",
    "styleId": "soft",
    "origin": "curated",
    "tokens": {
      "radius": 24,
      "gap": 22,
      "accent": "#047465",
      "ink": "#1a211e",
      "muted": "#5f6563",
      "surface": "#e6e9e8",
      "motion": 1,
      "duration": 300,
      "easing": 1,
      "distance": 7
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "kind": "sumomo-ui-settings",
    "version": 1,
    "id": "builtin-soft-compact",
    "name": "石墨 · 紧凑",
    "styleId": "soft",
    "origin": "curated",
    "tokens": {
      "radius": 12,
      "gap": 10,
      "accent": "#202020",
      "ink": "#202020",
      "muted": "#646464",
      "surface": "#e8e8e8",
      "motion": 2,
      "duration": 160,
      "easing": 2,
      "distance": 3
    },
    "overrides": {},
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  }
]);

export const GLASS_BACKGROUNDS = deepFreeze([
  {
    "id": 0,
    "label": "日光",
    "description": "银蓝窗光 · 既有背景",
    "background": "linear-gradient(112deg,transparent 14%,transparent 31%,#ffffff52 43%,transparent 57%),linear-gradient(108deg,transparent 55%,#344f6b29 76%,transparent 94%),linear-gradient(135deg,#e5ebf1 0%,#c3cfdc 58%,#abbccb 100%)"
  },
  {
    "id": 1,
    "label": "暮色",
    "description": "冷灰暮光 · 既有背景",
    "background": "linear-gradient(112deg,transparent 14%,transparent 31%,#ffffff52 43%,transparent 57%),linear-gradient(108deg,transparent 55%,#344f6b29 76%,transparent 94%),linear-gradient(135deg,#c4cedc 0%,#9aadc0 58%,#8299b0 100%)"
  },
  {
    "id": 2,
    "label": "高对比",
    "description": "明暗窗光 · 既有背景",
    "background": "linear-gradient(112deg,transparent 14%,transparent 31%,#ffffff52 43%,transparent 57%),linear-gradient(108deg,transparent 55%,#344f6b29 76%,transparent 94%),linear-gradient(135deg,#f0f4f8 0%,#bdcbd9 52%,#7b94ac 100%)"
  },
  {
    "id": 3,
    "label": "暖白窗影",
    "description": "奶油墙面与斜落窗影",
    "background": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201600%201000%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22wall%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23f3efe7%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23d6cbb9%22%2F%3E%3C%2FlinearGradient%3E%3Cfilter%20id%3D%22shadow%22%3E%3CfeGaussianBlur%20stdDeviation%3D%227%22%2F%3E%3C%2Ffilter%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22url(%23wall)%22%20d%3D%22M0%200h1600v1000H0z%22%2F%3E%3Cpath%20fill%3D%22%23fffdf6%22%20opacity%3D%22.8%22%20d%3D%22M210%200h780L630%201000H0V660z%22%2F%3E%3Cg%20fill%3D%22%238e8170%22%20opacity%3D%22.18%22%20filter%3D%22url(%23shadow)%22%3E%3Cpath%20d%3D%22M270%200h55L0%20936V792zM605%200h38L283%201000h-40zM965%200h44L650%201000h-45z%22%2F%3E%3Cpath%20d%3D%22M0%20270h1600v32H0zM0%20685h1600v25H0z%22%2F%3E%3C%2Fg%3E%3Cpath%20fill%3D%22%23ffffff%22%20opacity%3D%22.24%22%20d%3D%22M1080%200h520v1000H715z%22%2F%3E%3C%2Fsvg%3E\")"
  },
  {
    "id": 4,
    "label": "植物投影",
    "description": "叶片、枝梗与灰绿墙面",
    "background": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201600%201000%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22wall%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23eeeee5%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23d1dcd1%22%2F%3E%3C%2FlinearGradient%3E%3Cfilter%20id%3D%22leaf%22%3E%3CfeGaussianBlur%20stdDeviation%3D%222.5%22%2F%3E%3C%2Ffilter%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22url(%23wall)%22%20d%3D%22M0%200h1600v1000H0z%22%2F%3E%3Cg%20fill%3D%22%234f705c%22%20opacity%3D%22.31%22%20filter%3D%22url(%23leaf)%22%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22%234f705c%22%20stroke-width%3D%229%22%20d%3D%22M1590%201040Q1160%20630%201020-50M1325%20760Q1450%20360%201540%2040M1200%20520Q720%20280%20650-90%22%2F%3E%3Cellipse%20cx%3D%221170%22%20cy%3D%22670%22%20rx%3D%2256%22%20ry%3D%22160%22%20transform%3D%22rotate(-48%201170%20670)%22%2F%3E%3Cellipse%20cx%3D%221390%22%20cy%3D%22635%22%20rx%3D%2252%22%20ry%3D%22165%22%20transform%3D%22rotate(28%201390%20635)%22%2F%3E%3Cellipse%20cx%3D%221040%22%20cy%3D%22475%22%20rx%3D%2246%22%20ry%3D%22145%22%20transform%3D%22rotate(-57%201040%20475)%22%2F%3E%3Cellipse%20cx%3D%221190%22%20cy%3D%22375%22%20rx%3D%2245%22%20ry%3D%22145%22%20transform%3D%22rotate(34%201190%20375)%22%2F%3E%3Cellipse%20cx%3D%22980%22%20cy%3D%22230%22%20rx%3D%2248%22%20ry%3D%22150%22%20transform%3D%22rotate(-33%20980%20230)%22%2F%3E%3Cellipse%20cx%3D%221115%22%20cy%3D%22120%22%20rx%3D%2244%22%20ry%3D%22130%22%20transform%3D%22rotate(29%201115%20120)%22%2F%3E%3Cellipse%20cx%3D%221430%22%20cy%3D%22290%22%20rx%3D%2249%22%20ry%3D%22142%22%20transform%3D%22rotate(-24%201430%20290)%22%2F%3E%3Cellipse%20cx%3D%221570%22%20cy%3D%22165%22%20rx%3D%2250%22%20ry%3D%22155%22%20transform%3D%22rotate(33%201570%20165)%22%2F%3E%3Cellipse%20cx%3D%22835%22%20cy%3D%22255%22%20rx%3D%2242%22%20ry%3D%22132%22%20transform%3D%22rotate(-63%20835%20255)%22%2F%3E%3Cellipse%20cx%3D%22745%22%20cy%3D%2280%22%20rx%3D%2240%22%20ry%3D%22126%22%20transform%3D%22rotate(-28%20745%2080)%22%2F%3E%3C%2Fg%3E%3Cpath%20fill%3D%22%23ffffff%22%20opacity%3D%22.25%22%20d%3D%22M0%200h400l450%201000H0z%22%2F%3E%3C%2Fsvg%3E\")"
  },
  {
    "id": 5,
    "label": "雾山远景",
    "description": "浅色天空与层叠山形",
    "background": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201600%201000%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22sky%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23f1eee3%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23dce5de%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22mist%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23f2f0e6%22%20stop-opacity%3D%220%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23f2f0e6%22%20stop-opacity%3D%22.75%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22url(%23sky)%22%20d%3D%22M0%200h1600v1000H0z%22%2F%3E%3Ccircle%20fill%3D%22%23e4d3b5%22%20opacity%3D%22.65%22%20cx%3D%221210%22%20cy%3D%22205%22%20r%3D%22100%22%2F%3E%3Cpath%20fill%3D%22%23cbd3c9%22%20d%3D%22m0%20630%20215-160%20150%2073%20245-249%20155%20164%20140-105%20220%20210%20150-75%20325%20190v322H0z%22%2F%3E%3Cpath%20fill%3D%22%23b7c8be%22%20d%3D%22m0%20754%20222-126%20160%2034%20230-151%20165%20114%20150-65%20218%20158%20148-43%20307%20165v160H0z%22%2F%3E%3Cpath%20fill%3D%22%23a4bcb1%22%20d%3D%22m0%20918%20263-141%20182%2097%20218-72%20219%20103%20211-163%20216%2087%20291-90v261H0z%22%2F%3E%3Cpath%20fill%3D%22url(%23mist)%22%20d%3D%22M0%20460h1600v540H0z%22%2F%3E%3C%2Fsvg%3E\")"
  },
  {
    "id": 6,
    "label": "彩色光斑",
    "description": "杏色、苔绿与浅紫光面",
    "background": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201600%201000%22%3E%3Cdefs%3E%3CradialGradient%20id%3D%22peach%22%3E%3Cstop%20stop-color%3D%22%23e9b79e%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23f1d7c5%22%2F%3E%3C%2FradialGradient%3E%3CradialGradient%20id%3D%22lilac%22%3E%3Cstop%20stop-color%3D%22%23c4bbde%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23e2d9e9%22%2F%3E%3C%2FradialGradient%3E%3ClinearGradient%20id%3D%22green%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23e6e7c0%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23b8cfc1%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22%23ecebe6%22%20d%3D%22M0%200h1600v1000H0z%22%2F%3E%3Ccircle%20cx%3D%22230%22%20cy%3D%22250%22%20r%3D%22510%22%20fill%3D%22url(%23peach)%22%2F%3E%3Ccircle%20cx%3D%221370%22%20cy%3D%22775%22%20r%3D%22620%22%20fill%3D%22url(%23lilac)%22%2F%3E%3Cpath%20fill%3D%22url(%23green)%22%20d%3D%22M1030-130c-450%20230-725%20672-660%201130h410c-56-390%20211-785%20590-1000z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20opacity%3D%22.19%22%20d%3D%22M0%20640%201600%2080v75L0%20735z%22%2F%3E%3C%2Fsvg%3E\")"
  },
  {
    "id": 7,
    "label": "黑白构成",
    "description": "中性明暗平面与建筑边界",
    "background": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201600%201000%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22plane%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23f8f7f3%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23d0d0cc%22%2F%3E%3C%2FlinearGradient%3E%3Cfilter%20id%3D%22soft%22%3E%3CfeGaussianBlur%20stdDeviation%3D%2212%22%2F%3E%3C%2Ffilter%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22%23dfdfdc%22%20d%3D%22M0%200h1600v1000H0z%22%2F%3E%3Cpath%20fill%3D%22%23b5b6b4%22%20d%3D%22M0%200h485L105%201000H0z%22%2F%3E%3Cpath%20fill%3D%22%23929591%22%20opacity%3D%22.32%22%20filter%3D%22url(%23soft)%22%20d%3D%22M495%200h90L180%201000H95z%22%2F%3E%3Cpath%20fill%3D%22url(%23plane)%22%20d%3D%22M560%200h1040v1000H165z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M1075%200h525v525z%22%2F%3E%3Cpath%20fill%3D%22%23313733%22%20opacity%3D%22.36%22%20d%3D%22M1582%200h18v1000h-18z%22%2F%3E%3Cpath%20fill%3D%22%23a9aaa6%22%20opacity%3D%22.6%22%20d%3D%22m900%201000%20700-235v235z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20opacity%3D%22.6%22%20d%3D%22m855%201000%20745-250v20L900%201000z%22%2F%3E%3C%2Fsvg%3E\")"
  }
]);


// Color families and panel contrast rules follow the fixed Agora shared-menu
// sumomo-appearance-menu-v2-2026-10-16/appearance-model.js (SHA-256
// 757ddd4fe7eb854fd970a2ca68913e49e18647b0ed98ebb2f06957c4bec08700).
// Only data and pure rules are adapted; project preference keys remain local.
export const COLOR_PALETTES = deepFreeze([
  { id: 'plum', name: '梅紫', accent: '#80024e' },
  { id: 'blue', name: '海蓝', accent: '#0d73cc' },
  { id: 'green', name: '松绿', accent: '#027f6e' },
  { id: 'amber', name: '琥珀', accent: '#a56101' },
  { id: 'coral', name: '珊瑚', accent: '#d13415' },
  { id: 'graphite', name: '石墨', accent: '#202020' },
]);
const PALETTE_COLORS = deepFreeze({
  plum: { ink: '#211f26', muted: '#65636d', paper: '#faf9fb', soft: '#eae7ec' },
  blue: { ink: '#1c2024', muted: '#60646c', paper: '#f9f9fb', soft: '#e8e8ec' },
  green: { ink: '#1a211e', muted: '#5f6563', paper: '#f7f9f8', soft: '#e6e9e8' },
  amber: { ink: '#21201c', muted: '#63635e', paper: '#f9f9f8', soft: '#e9e8e6' },
  coral: { ink: '#211f26', muted: '#65636d', paper: '#faf9fb', soft: '#eae7ec' },
  graphite: { ink: '#202020', muted: '#646464', paper: '#f9f9f9', soft: '#e8e8e8' },
});

const SET_FIELDS = ['kind', 'version', 'id', 'name', 'styleId', 'origin', 'tokens', 'overrides', 'createdAt', 'updatedAt'];
const STATE_FIELDS = ['version', 'activeStyle', 'sets', 'presetIds'];
const LEGACY_STATE_FIELDS = ['version', 'activeStyle', 'sets'];
const STYLE_IDS = APPEARANCE_STYLES.map(style => style.id);
const COLOR_ROLES = ['accent', 'ink', 'muted', 'surface'];
const pass = value => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
const exactKeys = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => new TextEncoder().encode(value).length;
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validName = value => typeof value === 'string' && value.trim() === value && [...value].length >= 1 && [...value].length <= 40
  && !/[\u0000-\u001f\u007f<>\u2028\u2029]/.test(value);

// The portable set stays at v1. In particular, product metadata must never be
// added to it, and unsupported specimen overrides must never be dropped.
export function validateLibrarySet(value) {
  if (!exactKeys(value, SET_FIELDS)) return fail('schema', '方案格式不正确或含有不支持的字段');
  if (value.kind !== 'sumomo-ui-settings' || value.version !== 1) return fail('version', '这个方案版本暂不支持');
  if (!identity(value.id) || !validName(value.name)) return fail('identity', '方案名称或标识不正确');
  if (!['curated', 'custom'].includes(value.origin)) return fail('origin', '方案来源不正确');
  if (!STYLE_IDS.includes(value.styleId)) return fail('style', '方案的风格暂不支持');
  const controls = APPEARANCE_SCHEMA[value.styleId];
  if (!exactKeys(value.tokens, controls.map(control => control.key))) return fail('tokens', '方案必须包含完整且已知的共通调节项');
  const tokens = {};
  for (const control of controls) {
    const parameter = value.tokens[control.key];
    if (control.type === 'color') {
      if (!hexToRgb(parameter)) return fail('tokens', '颜色需要完整的六位 HEX 值');
    } else {
      if (typeof parameter !== 'number' || !Number.isFinite(parameter)) return fail('tokens', '调节项必须是有限数值');
      if (control.type === 'choice') {
        if (!control.options.some(option => option.value === parameter)) return fail('tokens', '方案含有不支持的选项');
      } else {
        if (parameter < control.min || parameter > control.max) return fail('tokens', '调节项超出范围');
        const increment = (parameter - control.min) / control.step;
        if (Math.abs(increment - Math.round(increment)) > 1e-7) return fail('tokens', '调节项不符合允许的步长');
      }
    }
    tokens[control.key] = parameter;
  }
  if (!plain(value.overrides) || Object.keys(value.overrides).length) return fail('overrides', '棋牌室暂不支持控件专属 overrides，原方案已保留');
  if (!validDate(value.createdAt) || !validDate(value.updatedAt) || value.createdAt > value.updatedAt) return fail('date', '方案日期不正确');
  const normalized = {
    kind: value.kind, version: 1, id: value.id, name: value.name, styleId: value.styleId, origin: value.origin,
    tokens, overrides: {}, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
  if (bytes(JSON.stringify(normalized)) > 32768) return fail('size', '单个方案不能超过 32 KiB');
  return pass(normalized);
}

export function createDefaultAppearanceState() {
  const presets = STYLE_IDS.map(styleId => APPEARANCE_PRESETS.find(set => set.styleId === styleId));
  return {
    version: 2,
    activeStyle: null,
    sets: Object.fromEntries(presets.map(preset => [preset.styleId, clone(preset)])),
    presetIds: Object.fromEntries(presets.map(preset => [preset.styleId, preset.id])),
  };
}

// Fresh installs use the accepted 2026-10-17 default: quiet soft material plus
// green colors, not the separate soft-sage material. Saved/explicit legacy
// choices still use createDefaultAppearanceState and normal validation.
// Reference shared-menu/appearance-model.js SHA-256:
// 7eb2ea9bf193e395630fcd890ab5d9a2e56ad389e9817501a877e021501f3422.
export function createInitialAppearanceState() {
  return chooseDefaultAppearance(createDefaultAppearanceState()).value;
}

export function chooseDefaultAppearance(state) {
  const selected = chooseAppearance(state, 'soft');
  if (!selected.ok) return selected;
  const material = choosePreset(selected.value, 'builtin-soft-quiet');
  return material.ok ? chooseColorPalette(material.value, 'green') : material;
}

function legacyPresetId(set) {
  const candidates = APPEARANCE_PRESETS.filter(preset => preset.styleId === set.styleId);
  if (set.origin === 'curated') return candidates.find(preset => preset.id === set.id)?.id ?? null;
  // Version 1 custom working copies discarded their source ID. Color and
  // background were the only editor-owned changes, so only an exact, unique
  // match of all other tokens can recover provenance. Never choose a nearest
  // preset, inspect the name, or replace any of the person's saved values.
  const keys = APPEARANCE_SCHEMA[set.styleId].map(control => control.key)
    .filter(key => !COLOR_ROLES.includes(key) && key !== 'background');
  const matches = candidates.filter(preset => keys.every(key => preset.tokens[key] === set.tokens[key]));
  return matches.length === 1 ? matches[0].id : null;
}

export function validateAppearanceState(value) {
  if (!plain(value) || ![1, 2].includes(value.version)
    || !exactKeys(value, value.version === 1 ? LEGACY_STATE_FIELDS : STATE_FIELDS)) return fail('state-schema', '本机外观记录格式或版本不受支持');
  if (value.activeStyle !== null && !STYLE_IDS.includes(value.activeStyle)) return fail('style', '本机外观记录含有未知风格');
  if (!exactKeys(value.sets, STYLE_IDS)) return fail('state-sets', '本机外观记录需要保留完整的三种风格');
  const sets = {};
  for (const styleId of STYLE_IDS) {
    const result = validateLibrarySet(value.sets[styleId]);
    if (!result.ok) return result;
    if (result.value.styleId !== styleId) return fail('style', '方案与所在风格不一致');
    sets[styleId] = result.value;
  }
  const presetIds = {};
  if (value.version === 1) {
    for (const styleId of STYLE_IDS) presetIds[styleId] = legacyPresetId(sets[styleId]);
  } else {
    if (!exactKeys(value.presetIds, STYLE_IDS)) return fail('preset-source', '本机外观记录需要完整的预设来源');
    for (const styleId of STYLE_IDS) {
      const id = value.presetIds[styleId];
      if (id !== null && !APPEARANCE_PRESETS.some(preset => preset.styleId === styleId && preset.id === id)) return fail('preset-source', '预设来源与所在风格不一致或不受支持');
      presetIds[styleId] = id;
    }
  }
  return pass({ version: 2, activeStyle: value.activeStyle, sets, presetIds });
}

export function chooseAppearance(state, styleId) {
  const result = validateAppearanceState(state);
  if (!result.ok) return result;
  if (styleId !== null && !STYLE_IDS.includes(styleId)) return fail('style', '请选择已支持的外观');
  return pass({ ...result.value, activeStyle: styleId });
}

export function choosePreset(state, setId) {
  const result = validateAppearanceState(state);
  if (!result.ok) return result;
  const current = result.value;
  const preset = APPEARANCE_PRESETS.find(set => set.id === setId && set.styleId === current.activeStyle);
  if (!preset) return fail('preset', '当前外观里没有这个预设');
  return pass({ ...current, sets: { ...current.sets, [current.activeStyle]: clone(preset) },
    presetIds: { ...current.presetIds, [current.activeStyle]: preset.id } });
}

function editedSet(set, tokens) {
  if (Object.keys(tokens).every(key => tokens[key] === set.tokens[key])) return set;
  const identityFields = set.origin === 'curated' ? {
    id: 'custom-' + set.styleId + '-local',
    name: APPEARANCE_STYLES.find(style => style.id === set.styleId).label + ' · 自定',
    origin: 'custom',
  } : {};
  // This is a deterministic working copy, not a saved library revision. Dates
  // remain valid input metadata; no clock, storage or identity service is read.
  return { ...set, ...identityFields, tokens: { ...set.tokens, ...tokens } };
}

export function updateAppearanceColors(state, colors) {
  const result = validateAppearanceState(state);
  if (!result.ok) return result;
  const current = result.value;
  if (current.activeStyle === null) return fail('style', '请先选择纸感、玻璃或柔感');
  if (!plain(colors) || !Object.keys(colors).length || Object.keys(colors).some(role => !COLOR_ROLES.includes(role))) return fail('colors', '请选择已支持的颜色角色');
  if (Object.values(colors).some(color => !hexToRgb(color))) return fail('colors', '颜色需要完整的六位 HEX 值');
  const styleId = current.activeStyle;
  return pass({ ...current, sets: { ...current.sets, [styleId]: editedSet(current.sets[styleId], colors) } });
}

export function paletteColors(styleId, paletteId) {
  if (!STYLE_IDS.includes(styleId)) return null;
  const palette = COLOR_PALETTES.find(item => item.id === paletteId);
  if (!palette) return null;
  const colors = PALETTE_COLORS[palette.id];
  return { accent: palette.accent, ink: colors.ink, muted: colors.muted,
    surface: styleId === 'glass' ? '#ffffff' : colors[styleId] };
}

export function chooseColorPalette(state, paletteId) {
  const result = validateAppearanceState(state);
  if (!result.ok) return result;
  const current = result.value, styleId = current.activeStyle;
  if (styleId === null) return fail('style', '请先选择纸感、玻璃或柔感');
  const colors = paletteColors(styleId, paletteId);
  if (!colors) return fail('palette', '请选择已支持的配色');
  return pass({ ...current, sets: { ...current.sets, [styleId]: editedSet(current.sets[styleId], colors) } });
}

export function currentColorPalette(state) {
  const result = validateAppearanceState(state);
  if (!result.ok || result.value.activeStyle === null) return null;
  const { activeStyle, sets } = result.value;
  return COLOR_PALETTES.find(palette => Object.entries(paletteColors(activeStyle, palette.id))
    .every(([key, value]) => sets[activeStyle].tokens[key].toLowerCase() === value))?.id ?? null;
}

export function safeAppearancePanelColors(tokens) {
  if (!plain(tokens) || COLOR_ROLES.some(key => !hexToRgb(tokens[key]))) throw new TypeError('面板需要完整且合法的四色');
  const surface = tokens.surface;
  const readable = (color, minimum) => contrastRatio(color, surface) >= minimum ? color : contrastingForeground(surface);
  const accent = readable(tokens.accent, 3);
  // These five colors are a rendering projection only. The product tokens,
  // portable set, source preset and selected background remain untouched.
  return { surface, ink: readable(tokens.ink, 4.5), muted: readable(tokens.muted, 4.5), accent,
    onAccent: contrastingForeground(accent) };
}

export function chooseGlassBackground(state, id) {
  const result = validateAppearanceState(state);
  if (!result.ok) return result;
  const current = result.value;
  if (current.activeStyle !== 'glass') return fail('style', '请先选择玻璃外观');
  if (!GLASS_BACKGROUNDS.some(background => background.id === id)) return fail('background', '请选择已支持的玻璃背景');
  return pass({ ...current, sets: { ...current.sets, glass: editedSet(current.sets.glass, { background: id }) } });
}

// Adapted from color-controls.mjs. Contrast only covers two opaque
// colors: transparent glass still needs inspection against the composited scene.
export function hexToRgb(value) {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) return null;
  return { r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16) };
}
export function rgbToHex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const channels = ['r', 'g', 'b'];
  if (Object.keys(value).length !== 3 || channels.some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 0 || value[key] > 255)) return null;
  return '#' + channels.map(key => value[key].toString(16).padStart(2, '0')).join('');
}
function relativeLuminance(value) {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const linear = channel => { const encoded = channel / 255; return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}
export function contrastRatio(first, second) {
  const a = relativeLuminance(first), b = relativeLuminance(second);
  if (a === null || b === null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function contrastingForeground(background) {
  const luminance = relativeLuminance(background);
  if (luminance === null) return null;
  const white = 1.05 / (luminance + 0.05), black = (luminance + 0.05) / 0.05;
  return white >= black ? '#ffffff' : '#000000';
}
