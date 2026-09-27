/** getLibrary —— 收藏列表：读真实收藏存储（收件箱确认入库的唯一来源），不造演示数据。
 *  空列表由收藏页渲染空态（「在收件箱粘贴内容时勾选收藏」）。 */
import type { CollectionItem } from '../types';
import { listCollections } from './collectionStore';

export default function getLibrary(): CollectionItem[] {
  return listCollections();
}
