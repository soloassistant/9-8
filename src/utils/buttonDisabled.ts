/**
 * <Button> 的 disabled 属性取值。
 *
 * ## 为什么需要这个函数（2026-10-24 实测）
 *
 * 直接把条件塞给 `disabled` 会让**没禁用**的按钮看起来像禁用、甚至完全看不见。
 * 根因是一条五步连锁，每一步都实测过：
 *
 * 1. Taro 的 WeUI 样式里有一条（`@tarojs/components/.../button/style/index.css`）：
 *    ```css
 *    taro-button-core[disabled] { color: rgba(255, 255, 255, 0.6) }
 *    ```
 * 2. **CSS 属性选择器只看属性「在不在」，不看它的值。**
 * 3. Taro H5 把 `<Button disabled={false}>` 渲染成 `disabled="false"` ——
 *    outerHTML 实测：`<taro-button-core loading="false" disabled="false" class="…">立即订阅</taro-button-core>`。
 *    （Stencil 组件的 `disabled` 是 `reflect: false`，属性是 React 绑定时给自定义元素写上去的，
 *    boolean 被字符串化成 `"false"`。）
 * 4. 特异性：`taro-button-core[disabled]` = (0,1,1) > 组件自己的类 `.subButton` = (0,1,0)
 *    ⇒ Taro 赢。于是同一条规则里 `background` 没人抢、照常生效，`color` 被顶掉。
 * 5. 结果：白底按钮 + 60% 白色文字 = **对比度 1.00，按钮整个消失**。
 *    实测 `pages/mine` 的「立即订阅」：`color: rgba(255,255,255,0.6)` / `bg: rgb(255,255,255)`，
 *    文案 `立即订阅` 在 DOM 里但看不见。
 *
 * ## 为什么是「返回 undefined」而不是「提高特异性」
 *
 * 提高特异性只能解决某一个按钮，而且 `disabled="false"` 与 `disabled="true"` 在 CSS 里
 * **无法区分**（都是「属性存在」）—— 也就是说纯 CSS 没法表达「只在真禁用时才变灰」。
 * 唯一干净的解法是让属性**只在真禁用时出现**：条件为假返回 `undefined`，React 就不会写这个属性。
 *
 * @example
 * <Button disabled={disabledAttr(paying)}>立即订阅</Button>
 */
export function disabledAttr(condition: boolean | undefined | null): true | undefined {
  return condition ? true : undefined
}
