//! Persistence spawns: conversation, local-activity, and decline records
//! written to SQLite in background tasks, plus the session-reset note.

use super::*;

impl UnderstandHandler {
    /// Persist a conversation to SQLite in a background task.
    pub(super) fn spawn_save_conversation(
        &self,
        run_id: &str,
        utterance: &str,
        is_vision: bool,
        history: &[Message],
        response_text: &str,
    ) {
        let db = self.db.clone();
        let run_id = run_id.to_string();
        let utterance = utterance.to_string();
        let history = history.to_vec();
        let response_text = response_text.to_string();

        tokio::spawn(async move {
            if let Err(e) = db
                .save_understand_conversation(
                    &run_id,
                    &utterance,
                    is_vision,
                    &history,
                    &response_text,
                )
                .await
            {
                warn!(error = %e, "failed to save conversation to db");
            }
        });
    }

    /// When the dispatched stock action clears the device's short-term
    /// understanding context, start a new server-side session at the same
    /// moment so the durable session store honors the same explicit reset.
    /// When the dispatched action clears stock's short-term context, reset the
    /// durable session store atomically with recording the reset turn. Returns
    /// `true` when it took ownership of persisting this turn, so the caller
    /// skips the generic activity save (which would otherwise write the reset
    /// turn a second time, above the marker).
    pub(super) fn note_session_reset_if_clear(
        &self,
        action_name: &str,
        run_id: &str,
        utterance: &str,
    ) -> bool {
        if action_name != native_actions::CLEAR_UNDERSTANDING_CONTEXT {
            return false;
        }
        let db = self.db.clone();
        let run_id = run_id.to_string();
        let utterance = utterance.to_string();
        tokio::spawn(async move {
            match db
                .reset_session_at_new_turn(
                    &run_id,
                    &utterance,
                    &format!("Action: {}", native_actions::CLEAR_UNDERSTANDING_CONTEXT),
                )
                .await
            {
                Ok(()) => info!("session store reset with ClearUnderstandingContext"),
                Err(error) => warn!(error = %error, "failed to reset the session store"),
            }
        });
        true
    }

    /// Record local planner outcomes for the authenticated Center activity
    /// view. Keep this deliberately smaller than provider history: only the
    /// user's utterance and a bounded final outcome are persisted.
    ///
    /// Prefer [`action_activity_outcome`] over a bare `"Action: {name}"` for any
    /// site that has the action's input in hand — the name alone cannot resolve
    /// a follow-up like *"play that one again"*.
    pub(super) fn spawn_save_local_activity(
        &self,
        run_id: &str,
        utterance: &str,
        is_vision: bool,
        outcome: &str,
    ) {
        let db = self.db.clone();
        let run_id = run_id.to_string();
        let utterance = utterance.to_string();
        let outcome = outcome.chars().take(4_096).collect::<String>();
        tokio::spawn(async move {
            if let Err(error) = db
                .save_conversation(
                    &run_id,
                    &utterance,
                    is_vision,
                    &[("assistant".into(), outcome)],
                )
                .await
            {
                warn!(error = %error, "failed to save local assistant activity");
            }
        });
    }

    /// Record a failure notice the *server* generated in place of an answer —
    /// a backend outage, a timeout, an exhausted step budget.
    ///
    /// Same activity row as [`Self::spawn_save_local_activity`], different
    /// message role. The Center still shows the turn; the durable session
    /// store no longer replays "I couldn't reach the service" to the model as
    /// though the assistant had said it. Backend failures are bursty, so that
    /// replay landed precisely on the turns most likely to fail again — the
    /// wearer heard one hiccup and then a second answer that was hedged,
    /// apologetic, or quietly wrong.
    pub(super) fn spawn_save_decline(
        &self,
        run_id: &str,
        utterance: &str,
        is_vision: bool,
        decline: &str,
    ) {
        let db = self.db.clone();
        let run_id = run_id.to_string();
        let utterance = utterance.to_string();
        let decline = decline.chars().take(4_096).collect::<String>();
        tokio::spawn(async move {
            if let Err(error) = db
                .save_decline_conversation(&run_id, &utterance, is_vision, &decline)
                .await
            {
                warn!(error = %error, "failed to save assistant decline activity");
            }
        });
    }
}
