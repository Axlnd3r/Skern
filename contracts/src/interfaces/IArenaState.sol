// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only view of the Arena used by the Registry to block reclassification.
interface IArenaState {
    /// @return True while any round's commit window is open.
    function anyCommitWindowOpen() external view returns (bool);
}
