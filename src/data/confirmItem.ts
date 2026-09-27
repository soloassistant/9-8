/** mock: confirmItem —— 将收件箱确认的日程/待办/收藏写入统一存储，晨报与 AI 即时可见 */
import type { CollectionItem, ScheduleEvent, TodoItem } from '../types';
import { readPlan, writePlan, nextId } from './dailyPlan';
import { addCollection } from './collectionStore';

export default function confirmItem(data?: {
  events?: Array<Omit<ScheduleEvent, 'id' | 'status' | 'createTime'>>;
  todos?: Array<Omit<TodoItem, 'id' | 'status' | 'createTime'>>;
  collection?: Omit<CollectionItem, 'id' | 'createTime'>;
}) {
  const plan = readPlan();
  let saved = 0;

  (data?.events || []).forEach((evt) => {
    plan.events.push({ ...evt, id: nextId('evt'), status: 'confirmed' });
    saved += 1;
  });
  (data?.todos || []).forEach((todo) => {
    plan.todos.unshift({ ...todo, id: nextId('todo'), status: 'confirmed' });
    saved += 1;
  });

  // 收藏真实落库（此前被静默丢弃，收藏页只能看到 mock）
  if (data?.collection && data.collection.title) {
    addCollection(data.collection);
    saved += 1;
  }

  if (saved > 0) writePlan(plan);
  console.info('[mock:confirmItem] saved:', saved);
  return { saved };
}