// Side-effect imports: each module registers itself with the tool registry.
// Import this module (not the individual files) to make every built-in tool
// available — the runtime does this once, before executing any task.
import './echo';
import './test-fail';
import './crm';
import './campaigns';
import './sales';
import './research';
import './outreach';
