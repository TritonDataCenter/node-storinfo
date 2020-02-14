/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

module.exports = {
    NotEnoughSpaceError: NotEnoughSpaceError,
    StandaloneModeError: StandaloneModeError
};

const mod_util = require('util');
const mod_verror = require('verror');
const VError = mod_verror.VError;

function NotEnoughSpaceError(size, cause) {
    var opts = {};
    opts.constructorOpt = NotEnoughSpaceError;
    this.size = size;
    this.cause = cause;
    VError.call(this, opts, 'Unable to place object (size: %s MB, cause: %s)',
        size, cause);
}
mod_util.inherits(NotEnoughSpaceError, VError);
NotEnoughSpaceError.prototype.name = 'NotEnoughSpacetError';

function StandaloneModeError() {
    var opts = {};
    opts.constructorOpt = StandaloneModeError;
    VError.call(this, opts, 'this method is not supported in standalone mode');
}
mod_util.inherits(StandaloneModeError, VError);
StandaloneModeError.prototype.name = 'StandaloneModeError';
