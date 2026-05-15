"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSpeedMode = isSpeedMode;
exports.sp = sp;
const globalState_1 = require("../state/globalState");
function isSpeedMode() {
    return !!globalState_1.globalState.getState().config?.speedMode;
}
function sp(normal) {
    return isSpeedMode() ? Math.max(30, Math.round(normal * 0.4)) : normal;
}
//# sourceMappingURL=speedHelper.js.map