// Global, CO-scoped documents search (complements app/routes/repos.js's per-repo
// /:repoId/documents listing). A CO number commonly spans multiple repos - see the
// dev/{initials}-{CO}-{n} branch naming convention, nothing ties a CO to a single repo -
// so this answers "show me every delivery doc for this CO, across every repo I can
// access" rather than "show me everything for one repo."

const express = require('express');
const requireAuth = require('../lib/auth/requireAuth');
const { sendSuccess, sendFailure } = require('../lib/respond');
const { isValidCoNumber } = require('../lib/validate');
const documentsService = require('../lib/pipeline/documentsService');
const logger = require('../lib/logger');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const coNumber = req.query.co ? String(req.query.co).trim() : '';
  if (!isValidCoNumber(coNumber)) {
    return sendFailure(res, 400, 'co must match ^C[0-9]{8}$');
  }

  try {
    const documents = await documentsService.listDocumentsForUserAndCo({ userId: req.session.user.id, coNumber });
    return sendSuccess(res, { coNumber, documents });
  } catch (err) {
    logger.error('global document search failed', { coNumber, error: err.message });
    return sendFailure(res, 500, 'Failed to search documents', { code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
