import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

describe('Role-Based Event Access Control - Frontend Verification', () => {
  it('EventList displays "My Event" for User and hides Create Event button', () => {
    const content = fs.readFileSync('frontend/src/pages/Events/EventList.tsx', 'utf-8');
    assert.ok(content.includes("user?.role === 'User' ? 'My Event' : 'Events'"), 'EventList must render My Event for User role');
    assert.ok(content.includes("user?.role !== 'User' &&"), 'EventList must hide Create Event button for User role');
    assert.ok(content.includes('EVENT_ASSIGNMENT_CHANGED'), 'EventList must listen for EVENT_ASSIGNMENT_CHANGED socket event');
    assert.ok(content.includes('No Event Assigned'), 'EventList must have No Event Assigned empty state for User');
  });

  it('EventDetail displays Access Denied screen on 403 status', () => {
    const content = fs.readFileSync('frontend/src/pages/Events/EventDetail.tsx', 'utf-8');
    assert.ok(content.includes('error.response?.status === 403'), 'EventDetail must catch 403 status');
    assert.ok(content.includes('Access Denied'), 'EventDetail must display Access Denied');
    assert.ok(content.includes('You do not have access to this event'), 'EventDetail must display explanatory message');
  });

  it('EventEdit displays Access Denied screen on 403 status', () => {
    const content = fs.readFileSync('frontend/src/pages/Events/EventEdit.tsx', 'utf-8');
    assert.ok(content.includes('err.response?.status === 403'), 'EventEdit must catch 403 status');
    assert.ok(content.includes('Access Denied'), 'EventEdit must display Access Denied');
  });

  it('DashboardLayout listens for real-time EVENT_ASSIGNMENT_CHANGED and redirects if needed', () => {
    const content = fs.readFileSync('frontend/src/layouts/DashboardLayout.tsx', 'utf-8');
    assert.ok(content.includes('EVENT_ASSIGNMENT_CHANGED'), 'DashboardLayout must listen for EVENT_ASSIGNMENT_CHANGED');
    assert.ok(content.includes('updateUser'), 'DashboardLayout must update user in store');
  });

  it('JustAccess provides event assignment management and displays assigned events', () => {
    const content = fs.readFileSync('frontend/src/pages/Admin/JustAccess.tsx', 'utf-8');
    assert.ok(content.includes('assign-event'), 'JustAccess must call assign-event API');
    assert.ok(content.includes('Assigned Event'), 'JustAccess must show Assigned Event column');
    assert.ok(content.includes('Assign Event to User'), 'JustAccess must have modal to assign event');
  });

  it('UserApprovals allows assigning event upon approval', () => {
    const content = fs.readFileSync('frontend/src/pages/Admin/UserApprovals.tsx', 'utf-8');
    assert.ok(content.includes('assignedEventId: assignEventId'), 'UserApprovals must pass assignedEventId');
    assert.ok(content.includes('Assign Event (Optional)'), 'UserApprovals must render Assign Event field');
  });
});

describe('Role-Based Event Access Control - Backend Verification', () => {
  it('eventAuthService provides getAuthorizedEventIds and isEventAuthorized', () => {
    const content = fs.readFileSync('backend/src/services/eventAuthService.ts', 'utf-8');
    assert.ok(content.includes('export const getAuthorizedEventIds'), 'Must export getAuthorizedEventIds');
    assert.ok(content.includes('export const isEventAuthorized'), 'Must export isEventAuthorized');
    assert.ok(content.includes("user.role === 'SuperAdmin'"), 'SuperAdmin must have full access (return null)');
    assert.ok(content.includes("user.role === 'Admin'"), 'Admin must be scoped to managed users and events');
    assert.ok(content.includes('assignedEventId'), 'User must be restricted to assigned event');
  });

  it('eventController enforces event authorization on GET, PUT, DELETE, and detail routes', () => {
    const content = fs.readFileSync('backend/src/controllers/eventController.ts', 'utf-8');
    assert.ok(content.includes('isEventAuthorized'), 'eventController must use isEventAuthorized');
    assert.ok(content.includes('getAuthorizedEventIds'), 'eventController must use getAuthorizedEventIds');
    assert.ok(content.includes('Access denied. You do not have access to this event.'), 'eventController must return standard 403 message');
    assert.ok(content.includes('EVENT_ASSIGNMENT_CHANGED'), 'eventController must emit EVENT_ASSIGNMENT_CHANGED');
  });

  it('dashboardController restricts stats and activity to authorized events', () => {
    const content = fs.readFileSync('backend/src/controllers/dashboardController.ts', 'utf-8');
    assert.ok(content.includes('isEventAuthorized'), 'dashboardController must check isEventAuthorized');
    assert.ok(content.includes('getAuthorizedEventIds'), 'dashboardController must check getAuthorizedEventIds');
  });

  it('contactController enforces event authorization on add, get, import, update, and delete', () => {
    const content = fs.readFileSync('backend/src/controllers/contactController.ts', 'utf-8');
    assert.ok(content.includes('isEventAuthorized'), 'contactController must check isEventAuthorized');
    assert.ok(content.includes('Access denied. You do not have access to this event.'), 'contactController must return standard 403 message');
  });

  it('campaignController enforces event authorization on get, save, and send', () => {
    const content = fs.readFileSync('backend/src/controllers/campaignController.ts', 'utf-8');
    assert.ok(content.includes('isEventAuthorized'), 'campaignController must check isEventAuthorized');
    assert.ok(content.includes('Access denied. You do not have access to this event.'), 'campaignController must return standard 403 message');
  });

  it('reportController enforces event authorization on stats and logs', () => {
    const content = fs.readFileSync('backend/src/controllers/reportController.ts', 'utf-8');
    assert.ok(content.includes('isEventAuthorized'), 'reportController must check isEventAuthorized');
    assert.ok(content.includes('Access denied. You do not have access to this event.'), 'reportController must return standard 403 message');
  });

  it('adminController exposes assignUserEvent with real-time socket emission', () => {
    const content = fs.readFileSync('backend/src/controllers/adminController.ts', 'utf-8');
    assert.ok(content.includes('export const assignUserEvent'), 'adminController must export assignUserEvent');
    assert.ok(content.includes('EVENT_ASSIGNMENT_CHANGED'), 'adminController must emit EVENT_ASSIGNMENT_CHANGED');
    assert.ok(content.includes('USER_EVENT_ASSIGNED'), 'adminController must log USER_EVENT_ASSIGNED audit');
  });
});
