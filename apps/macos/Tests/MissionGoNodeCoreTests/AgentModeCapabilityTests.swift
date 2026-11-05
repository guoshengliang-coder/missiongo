import XCTest
@testable import MissionGoNodeCore

final class AgentModeCapabilityTests: XCTestCase {
    func testAutoRequiresExactNativeConfirmationRatherThanProviderOrModelSpelling() {
        XCTAssertEqual(ClaudeModeProbe.result(mode: "auto", response: ["subtype": "success", "response": ["mode": "auto"]], model: "gateway-model").state, "available")
        XCTAssertEqual(ClaudeModeProbe.result(mode: "auto", response: ["subtype": "success", "response": ["mode": "default"]], model: "official-looking-model").state, "unavailable")
        XCTAssertEqual(ClaudeModeProbe.result(mode: "auto", response: ["subtype": "success"]).state, "unknown")
        XCTAssertEqual(ClaudeModeProbe.result(mode: "auto", response: ["subtype": "error"]).state, "unavailable")
    }
    func testPlanningUsesReadOnlyAndNativeCollaborationModeRegardlessOfImplementationPermission() throws {
        for mode in ["default", "auto", "read-only"] {
            let policy = try XCTUnwrap(CodexModes.threadSettings(for: mode, planning: true))
            XCTAssertEqual(policy.sandbox, "read-only")
            let params = CodexProtocol.turnStartParams(threadId: "thread", prompt: "Plan only",
                overrides: CodexTurnOverrides(model: "fixture-model", settings: policy))
            XCTAssertEqual((params["sandboxPolicy"] as? [String: String])?["type"], "readOnly")
            XCTAssertEqual((params["collaborationMode"] as? [String: Any])?["mode"] as? String, "plan")
        }
    }
    func testPermissionChangeNeverCreatesPlanApproval() throws {
        let pending = try CodexTurnOverrides(desired: AgentSessionSettings(revision: 1, mode: "auto", planApproved: false))
        XCTAssertEqual(pending.settings?.sandbox, "read-only")
        XCTAssertEqual(pending.settings?.planning, true)
        let approved = try CodexTurnOverrides(desired: AgentSessionSettings(revision: 2, mode: "auto", planApproved: true))
        XCTAssertEqual(approved.settings?.sandbox, "workspace-write")
        XCTAssertEqual(approved.settings?.approvalsReviewer, "auto_review")
    }
}
