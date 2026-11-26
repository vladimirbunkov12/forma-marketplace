module.exports = function registerSellerCommissionRoutes(app, db, requireLogin) {
  // Получить текущее предложение только для компании из сессии продавца.
  app.get("/api/seller/commission-proposal", requireLogin, async (req, res) => {
    try {
      const companyId = req.session.companyId;
      const company = await db.prepare(`
        SELECT commission_rate_bps
        FROM companies
        WHERE id = ?
      `).get(companyId);

      if (!company) {
        return res.status(404).json({
          success: false,
          message: "Компания не найдена."
        });
      }

      const proposal = await db.prepare(`
        SELECT id, old_rate_bps, new_rate_bps, created_at
        FROM commission_change_proposals
        WHERE company_id = ? AND status = 'pending'
        ORDER BY id DESC
        LIMIT 1
      `).get(companyId);

      return res.json({
        success: true,
        currentRateBps: company.commission_rate_bps,
        proposal: proposal || null
      });
    } catch (error) {
      console.error("Ошибка загрузки предложения комиссии:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить предложение комиссии."
      });
    }
  });

  // Зафиксировать решение продавца. Компания определяется только по сессии.
  app.post(
    "/api/seller/commission-proposals/:id/decision",
    requireLogin,
    async (req, res) => {
      const proposalId = Number(req.params.id);
      const decision = req.body?.decision;
      const companyId = req.session.companyId;

      if (!Number.isSafeInteger(proposalId) || proposalId < 1 ||
          !["accepted", "rejected"].includes(decision)) {
        return res.status(400).json({
          success: false,
          message: "Некорректное решение по предложению."
        });
      }

      try {
        const decideProposal = db.transaction(async () => {
          const proposal = await db.prepare(`
            SELECT id, old_rate_bps, new_rate_bps, status
            FROM commission_change_proposals
            WHERE id = ? AND company_id = ?
          `).get(proposalId, companyId);

          if (!proposal) return { kind: "not_found" };
          if (proposal.status !== "pending") {
            return { kind: "already_decided" };
          }

          const company = await db.prepare(`
            SELECT commission_rate_bps
            FROM companies
            WHERE id = ?
          `).get(companyId);

          if (!company) return { kind: "company_missing" };

          if (Number(company.commission_rate_bps) !==
              Number(proposal.old_rate_bps)) {
            await db.prepare(`
              UPDATE commission_change_proposals
              SET status = 'stale', decided_at = CURRENT_TIMESTAMP
              WHERE id = ? AND company_id = ? AND status = 'pending'
            `).run(proposalId, companyId);
            return { kind: "stale" };
          }

          if (decision === "accepted") {
            const updateCompany = await db.prepare(`
              UPDATE companies
              SET commission_rate_bps = ?
              WHERE id = ? AND commission_rate_bps = ?
            `).run(
              proposal.new_rate_bps,
              companyId,
              proposal.old_rate_bps
            );

            if (updateCompany.changes !== 1) {
              await db.prepare(`
                UPDATE commission_change_proposals
                SET status = 'stale', decided_at = CURRENT_TIMESTAMP
                WHERE id = ? AND company_id = ? AND status = 'pending'
              `).run(proposalId, companyId);
              return { kind: "stale" };
            }
          }

          const updateProposal = await db.prepare(`
            UPDATE commission_change_proposals
            SET status = ?, decided_at = CURRENT_TIMESTAMP
            WHERE id = ? AND company_id = ? AND status = 'pending'
          `).run(decision, proposalId, companyId);

          if (updateProposal.changes !== 1) {
            throw new Error("Предложение уже обработано.");
          }

          return {
            kind: "decided",
            status: decision,
            commissionRateBps: decision === "accepted"
              ? Number(proposal.new_rate_bps)
              : Number(company.commission_rate_bps)
          };
        });

        const result = await decideProposal();
        if (result.kind === "not_found") {
          return res.status(404).json({
            success: false,
            message: "Предложение не найдено."
          });
        }
        if (result.kind === "company_missing") {
          return res.status(404).json({
            success: false,
            message: "Компания не найдена."
          });
        }
        if (result.kind === "already_decided") {
          return res.status(409).json({
            success: false,
            message: "Это предложение уже обработано или отменено."
          });
        }
        if (result.kind === "stale") {
          return res.status(409).json({
            success: false,
            stale: true,
            message: "Предложение устарело и не было применено."
          });
        }

        return res.json({
          success: true,
          status: result.status,
          commissionRateBps: result.commissionRateBps
        });
      } catch (error) {
        console.error("Ошибка решения по комиссии:", error);
        return res.status(500).json({
          success: false,
          message: "Не удалось сохранить решение по комиссии."
        });
      }
    }
  );
};
