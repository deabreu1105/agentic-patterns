import './helpers/string-colors.js';
import { getMessageFromModel, getMessageFromModelFailSafe } from './actions/get-message-model.js';

console.clear();

await getMessageFromModel();

//await getMessageFromModelFailSafe();
