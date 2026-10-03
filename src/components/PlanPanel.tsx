import { ListChecks } from 'lucide-react';
import { useClaw } from '../lib/store';

export default function PlanPanel() {
  const plan = useClaw((s) => s.plan);
  if (!plan || plan.length === 0) return null;

  const done = plan.filter((p) => p.status === 'done').length;
  const total = plan.length;

  return (
    <div className="plan-panel">
      <div className="plan-header">
        <ListChecks size={11} />
        <span>Plan</span>
        <span className="muted" style={{ marginLeft: 'auto' }}>{done}/{total} done</span>
      </div>
      <div className="plan-items">
        {plan.map((item, i) => (
          <div key={i} className={`plan-item ${item.status}`}>
            <div className="plan-item-status" />
            <span className="plan-item-text">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
