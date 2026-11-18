import { STATUS } from '../util.js';

export default function StatusBadge({ status }) {
  const [label, tone] = STATUS[status] || [status, 'muted'];
  return <span className={`badge ${tone}`}>{label}</span>;
}
