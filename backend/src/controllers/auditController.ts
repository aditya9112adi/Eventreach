import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';

export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    
    // Build query filters
    const query: any = {};
    if (req.query.action) query.action = req.query.action;
    if (req.query.collectionName) query.collectionName = req.query.collectionName;
    if (req.query.bulkOperationId) query.bulkOperationId = req.query.bulkOperationId;
    if (req.query.requestId) query.requestId = req.query.requestId;
    if (req.query.userId) query['actor.userId'] = req.query.userId;
    if (req.query.status) query.success = req.query.status === 'success';

    // Date range
    if (req.query.startDate || req.query.endDate) {
      query.timestamp = {};
      if (req.query.startDate) query.timestamp.$gte = new Date(req.query.startDate as string);
      if (req.query.endDate) query.timestamp.$lte = new Date(req.query.endDate as string);
    }

    // Text search on description (if requested)
    if (req.query.search) {
      query.description = { $regex: req.query.search, $options: 'i' };
    }

    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const totalLogs = await AuditLog.countDocuments(query);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        total: totalLogs,
        totalPages: Math.ceil(totalLogs / limit)
      }
    });
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
};

export const getAuditStatistics = async (req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalEvents = await AuditLog.countDocuments();
    const todayEvents = await AuditLog.countDocuments({ timestamp: { $gte: today } });
    const bulkOperations = await AuditLog.countDocuments({ 'bulk.isBulk': true });
    const failedOperations = await AuditLog.countDocuments({ success: false });
    
    const collectionStats = await AuditLog.aggregate([
      { $group: { _id: '$collectionName', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const recentBulk = await AuditLog.find({ 'bulk.isBulk': true })
      .sort({ timestamp: -1 })
      .limit(5)
      .lean();

    res.json({
      totalEvents,
      todayEvents,
      bulkOperations,
      failedOperations,
      collectionStats: collectionStats.map(s => ({ collectionName: s._id, count: s.count })),
      recentBulk
    });
  } catch (error) {
    console.error('Get audit stats error:', error);
    res.status(500).json({ error: 'Failed to fetch audit statistics' });
  }
};
